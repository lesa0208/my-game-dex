# Owner recovery and succession runbook

**Status:** written for M8, from the implemented migrations (`20261116100100_m8a_owner.sql` to `20261118100000_m8d_admin.sql`). It has been exercised on the local stack only, by the test suites. **No hosted project exists, and no real Owner has been assigned.** Before production, rehearse every procedure here on a staging project (see [Production launch prerequisites](../architecture/security-rls.md#production-launch-prerequisites-m8)).

Read [The Owner (M8)](../architecture/security-rls.md#the-owner-m8) and [ADR-055](../architecture/architecture-decisions.md#adr-055-the-owner-is-a-protected-record-its-authority-needs-mature-mfa-and-recovery-is-an-audited-operator-procedure) first. This runbook covers what people do. The database enforces the timings and checks described here, and nobody can shorten them from the app.

**Never put credentials, recovery codes, the succession document, its custodians' contact details or anyone's identity documents into this repository, a ticket, a chat or the database.** A case reference and the document's SHA-256 fingerprint are the only recovery details that go into the database.

## Fixed parameters

These are enforced in the database, not by this runbook:

| Parameter | Value | Where |
| --- | --- | --- |
| Recovery hold | 72 hours from opening | `private.begin_owner_recovery`, `private.complete_owner_recovery` |
| Factor maturity | 24 hours after a verified factor is first registered | `private.mature_totp_factor_count` |
| Factors for Owner authority | At least 2 mature, verified TOTP factors | `private.owner_authority_refusal` |
| Factors to become Owner | At least 2 verified TOTP factors (maturity follows) | `private.assign_initial_owner`, `private.complete_owner_recovery`, `public.accept_ownership_transfer` |
| Fresh verification for sensitive actions | A TOTP verification in the last 10 minutes, at most 60 seconds ahead of the database clock | `private.require_recent_mfa` |
| Transfer expiry | 72 hours | `public.start_ownership_transfer` |
| Dispute window | A disputed recovery can be opened within 30 days of a recovery the Owner cancelled | `private.begin_owner_recovery` |
| Pending at once | One transfer, one recovery | Partial unique indexes |

## People

| Role | Who | What they can do |
| --- | --- | --- |
| **Owner** | The account named in `private.platform_owner` | Owner-only actions in `/admin`, when eligible. Cancels a recovery they didn't ask for |
| **Successor** | An administrator the Owner designated | Nothing extra. They're the expected target of a reassignment |
| **Approvers** | The two people the succession document names | Approve a reassignment in writing |
| **Custodians** | The two people holding the signed succession document | Present it during a reassignment. They may be the approvers |
| **Operator** | A named person with a direct database connection as `postgres` and the Auth secret key | Runs the SQL and Admin API steps here, and nothing else |
| **Product owner** | As today | Approves an operator acting, in writing, before any step |

**Separation of duties is procedural.** The database can't tell which person runs SQL as `postgres`, so these rules are enforced by people and recorded in the case file:

- The operator is never the person who gains ownership.
- The operator never acts on their own request. The product owner's written approval comes first.
- In a reassignment, the approvers and custodians aren't the target.
- Each case has a written record kept outside the database: who asked, how identity was checked, the approvals, every command run and its result.

## Before anything goes wrong

The Owner does this once, then whenever something changes:

1. **Keep two authenticators, on separate devices.** Settings → Security lists each factor and when it matures. Recovery codes aren't available in this Auth version, so the second authenticator is the backup.
2. **Designate a successor** in `/admin/ownership`. It must be another administrator in good standing. Every administrator can see who it is, and it gives them nothing. It's cleared automatically if they lose the administrator role.
3. **Prepare the succession document.** A signed document naming the successor, the two approvers, and the conditions under which a reassignment may happen, such as the Owner being unreachable for a stated period. Give the signed copy to the two custodians.
4. **Register its fingerprint.** Compute the SHA-256 of the exact file the custodians hold, on your own machine:

   ```bash
   sha256sum succession.pdf
   ```

   ```powershell
   Get-FileHash -Algorithm SHA256 .\succession.pdf
   ```

   Enter the 64 hex digits in `/admin/ownership` → Succession document. This needs full Owner authority and a fresh verification. Administrators then see only that a document is registered, never its fingerprint. Replace the registration whenever the document changes; the custodians destroy the old copy.

5. **Agree on case references** that contain no personal information, such as `OR-2027-001`. The reference goes into the audit log, which is retained under the retention policy that's still to be decided.

## Operator ground rules

- **Connect directly to the database as `postgres`,** from an operator machine. Never from application code, never through the Data API, and never with credentials stored in the repository.
- **Run each step inside `begin; … commit;`,** read the result, and roll back if it isn't what this runbook says.
- **Use only the functions named here.** Never disable triggers, set `session_replication_role`, or write to `private.platform_owner`, `private.owner_recoveries`, `public.staff_roles`, `private.audit_events` or any `auth` table by hand. The functions write the audit rows; hand edits don't.
- **Make Auth changes only through the Auth Admin API** with the secret key, such as removing factors or banning an account. Record each one with `private.record_operator_action` (below), because Auth's own log isn't part of ours.
- **Check the Owner's state before and after:**

  ```sql
  select * from private.owner_integrity();
  ```

  No rows means nothing is wrong. Findings include `owner has 1 verified TOTP factors`, `owner has 0 mature TOTP factors`, `owner security changed in the last 24 hours`, `recovery pending`, `transfer pending`, `owner account: inactive` (suspended), `owner account: banned` and `auth contract broken`.

- **Record an Auth Admin API action** in the audit log, in the same session:

  ```sql
  begin;
  select private.record_operator_action(
    (select id from public.profiles where handle = '<handle>'),
    '<case ref>: removed 2 TOTP factors through the Auth Admin API',
    '{"auth_action": "factors_removed", "count": 2}'
  );
  commit;
  ```

## Assigning the first Owner

Done once per environment, only with the product owner's written approval. It's the M8 replacement for [Assigning the first administrator](../architecture/security-rls.md#assigning-the-first-administrator).

1. The approved person creates an account, verifies their email, claims a handle, and adds **two** authenticators in Settings → Security.
2. The operator runs:

   ```sql
   begin;
   select private.assign_initial_owner('<approved handle>', 'Initial Owner, approved by the product owner on <date>, case <case ref>');
   select * from private.owner_integrity();
   commit;
   ```

   It refuses if an Owner exists, if the account isn't in good standing (verified, active, with a handle, not banned or deleted), or with fewer than two verified factors. It grants the administrator role if needed, and writes `owner_assigned`.
3. `owner_integrity()` shows `owner has 0 mature TOTP factors` or `owner security changed in the last 24 hours` until the Owner's factors are 24 hours old. Owner-only actions wait until then. Protection starts immediately.

The Owner record can't be deleted or emptied afterwards. It only changes hands through a transfer or a recovery.

## Scenario A: the Owner lost one authenticator

**No operator is involved.**

1. The Owner signs in with their password and the remaining authenticator.
2. In Settings → Security, they **remove the lost factor**, so whoever finds the device can't use it, and **add a new one**. Auth requires a verified session to do either while a verified factor exists, so a stolen password alone can't.
3. Until the new factor is 24 hours old, Owner-only actions are refused (`owner_ineligible`): granting or revoking administrators, suspending administrators, transfers, the successor and the succession document. Ordinary administrator work continues. Administrators see "Owner security changed".
4. After 24 hours, Settings → Security shows both factors as mature, and Owner authority returns.

**Protection never lapses.** Whatever the Owner's factors, the account can't be deleted, suspended from the app, or lose its administrator role, and ownership can't move except through a transfer or a recovery.

**The cooling period is deliberate.** Someone holding the password and one device can't gain full Owner authority straight away.

## Scenario B: the Owner lost both authenticators (factor reset)

The Owner can still prove who they are, but can't reach a verified session.

1. **The Owner contacts the operator** through a channel agreed beforehand, never only through the account's email, which may be compromised.
2. **Identity check.** The operator and the product owner confirm the Owner's identity out of band, for example on a video call with someone who knows them, and record how in the case file.
3. **Open the recovery:**

   ```sql
   begin;
   select private.begin_owner_recovery('factor_reset', null, '<case ref>');
   commit;
   ```

   It returns the recovery id. It cancels any pending transfer, freezes Owner authority (`recovery_pending`) and writes `owner_recovery_started`. Every administrator sees a recovery banner in `/admin`.
4. **Notify the administrators** that a recovery is open, through the agreed channel. If the real Owner didn't ask for it and still has an authenticator, they cancel it in `/admin/ownership` (see [Disputes](#disputed-recovery-and-cancellation)).
5. **Wait out the 72-hour hold.** Completion is refused before it ends.
6. **Complete it:**

   ```sql
   begin;
   select private.complete_owner_recovery('<recovery id>', '<case ref>');
   commit;
   ```

   It writes `owner_recovery_completed`. A factor reset doesn't change who is Owner.
7. **Remove the Owner's factors through the Auth Admin API** with the secret key, from the operator machine: list them with `auth.admin.mfa.listFactors({ userId })`, then delete each with `auth.admin.mfa.deleteFactor({ userId, id })`. Record it with `record_operator_action`. Any session the Owner still has loses its verification at once, which the live checks see.
8. **The Owner signs in with their password** and adds two new authenticators in Settings → Security. With no verified factor left, Auth allows that from a password-only session. Each verification registers the factor.
9. **After 24 hours**, both factors mature and Owner authority returns. Check `owner_integrity()` with the Owner.

**If the password is lost as well,** the Owner resets it by email first. The app has no password-reset page yet (a [hosted registration requirement](../architecture/security-rls.md#requirements-before-any-hosted-registration)). If the email account is lost too, the operator can't safely tell the Owner from an impostor through this procedure: treat it as Scenario C.

## Scenario C: the Owner is compromised or unavailable (reassignment)

Ownership moves to another account, normally the designated successor.

### Conditions

- The succession document's conditions are met, and **both approvers** it names approve in writing.
- The **custodians present the document**. The operator computes its SHA-256 as in [Before anything goes wrong](#before-anything-goes-wrong). If a fingerprint is registered, the database refuses any other value ('succession document does not match'). If none is registered, it records `none registered`, and the product owner's written approval has to stand in for it. Note this in the case file.
- The **target is in good standing** and will have two verified authenticators by completion. The audit row records whether the target is the designated successor.
- The target's identity is checked out of band, and recorded.

### Containing a compromised Owner first

If the Owner's account may be in someone else's hands, the operator can contain it before opening the recovery, with the same approvals:

```sql
begin;
select private.operator_set_owner_status('suspended', '<case ref>: contained pending recovery');
commit;
```

A suspended Owner keeps every protection but loses all staff access, so they can't cancel a recovery: the staff check refuses them before anything else ('not permitted'). It writes `owner_status_set_by_operator`. Nothing in the app can change the Owner's status, the Owner's own action included. `private.operator_set_owner_status('active', …)` reverses it.

The operator may also remove the Owner's factors through the Auth Admin API, which ends their verified sessions immediately. Record it. Suspension doesn't end Auth sessions or block sign-in (M4-D7), but the database refuses every protected action.

**Suspending the real Owner on a false claim is itself a takeover step.** Never contain without the approvals.

### Steps

1. **Open the recovery:**

   ```sql
   begin;
   select private.begin_owner_recovery('reassign', '<target handle>', '<case ref>', '<sha-256 or null>');
   commit;
   ```

   It refuses a target that's the Owner or isn't in good standing, a fingerprint that doesn't match, a fingerprint when none is registered, and a second pending recovery. It cancels any pending transfer and freezes Owner authority. `owner_recovery_started` records the kind, whether the fingerprint matched, and whether the target is the designated successor.
2. **The target confirms** in Settings → Security, from a session verified in the last 10 minutes. That proves they control the account and an authenticator. It writes `owner_recovery_confirmed`. Completion is refused without it.
3. **Wait out the 72-hour hold.** The real Owner may cancel during it, if not contained; see [Disputes](#disputed-recovery-and-cancellation).
4. **Complete it:**

   ```sql
   begin;
   select private.complete_owner_recovery('<recovery id>', '<case ref>');
   select * from private.owner_integrity();
   commit;
   ```

   In one transaction, it checks the hold, the confirmation, the target's standing and two verified factors, and that the Owner hasn't changed since the recovery opened. Then:
   - ownership moves to the target, and the Owner record's version increases;
   - the target becomes an administrator if needed;
   - **the previous Owner loses the administrator role** (D6c);
   - the successor and the succession fingerprint are cleared, because they were the previous Owner's.

   The result says whether the previous Owner's administrator role was removed, and so does `owner_recovery_completed`.
5. **The new Owner's authority waits for factor maturity.** Their factors must be registered for 24 hours. `owner_integrity()` reports it until then.
6. **Then the new Owner** designates a successor, and has a new succession document prepared and registered.
7. **Rotate credentials:** see [After any recovery](#after-any-recovery).

The previous Owner is now an ordinary account. It's no longer protected from deletion, and an administrator can suspend it through `/admin/accounts` with a fresh verification, if needed.

## Disputed recovery and cancellation

**The Owner can cancel a recovery** in `/admin/ownership` from a session verified in the last 10 minutes, in good standing, with the administrator role. Full Owner authority isn't needed: one authenticator is enough, so a real Owner who lost a factor can stop a takeover. It writes `owner_recovery_cancelled` with `by: owner`. Refused attempts are audited (`staff_change_refused`, with the code).

**A compromised session can't block recovery for ever.** If the operator, the product owner and the approvers believe a cancellation came from a compromised session:

1. Within 30 days of that cancellation, the operator opens a **disputed** recovery:

   ```sql
   begin;
   select private.begin_owner_recovery('<factor_reset or reassign>', '<target handle or null>', '<case ref>', '<sha-256 or null>', true);
   commit;
   ```

   The database refuses `disputed = true` unless the Owner cancelled one in the last 30 days.
2. The app can't cancel a disputed recovery (`recovery_disputed`). Only an operator can:

   ```sql
   begin;
   select private.cancel_owner_recovery_by_operator('<recovery id>', '<case ref>: <decision>');
   commit;
   ```

3. A disputed recovery still needs the 72-hour hold, and for a reassignment the fingerprint and the target's confirmation.
4. **Escalation:** the product owner and both approvers decide whether it proceeds, and record the decision. Consider [containment](#containing-a-compromised-owner-first) while they decide.

## After any recovery

- **The previous Owner, if compromised:** their factors removed through the Admin API, a ban through the Admin API if needed, and a password reset. Each recorded with `record_operator_action`.
- **Operator credentials:** rotate the database password and the Auth secret key if either was used from a machine that may be compromised, or if the case involved anyone holding them. The app's server needs the new secret key.
- **Succession:** a new successor, a new document, a new fingerprint. The custodians destroy the old document.
- **Review the audit log** for what the compromised account did during the window: `/admin/audit`, filtered by its handle as actor.
- **Close the case file,** with every command, result and audit id.

## The audit trail

| Step | Action | Outcome | Actor |
| --- | --- | --- | --- |
| First Owner assigned | `owner_assigned` | operator | none |
| Recovery opened or completed | `owner_recovery_started`, `owner_recovery_completed` | operator | none |
| Owner's status set by an operator | `owner_status_set_by_operator` | operator | none |
| Target confirms | `owner_recovery_confirmed` | succeeded | the target |
| Owner cancels | `owner_recovery_cancelled` | succeeded | the Owner |
| Operator cancels | `owner_recovery_cancelled` | operator | none |
| Auth Admin API change | `operator_action` | operator | none |
| Refused attempt by staff | `staff_change_refused` or `owner_protection_refused` | refused | the staff member |
| Transfer started, accepted, cancelled or declined | `ownership_transfer_*` | succeeded | the Owner or the target |
| Successor set, document registered | `owner_successor_set`, `owner_succession_registered` | succeeded | the Owner |

Administrators read these in `/admin/audit`. An operator reads them directly:

```sql
select occurred_at, action, outcome, reason, metadata
from private.audit_events
where action::text like 'owner%' or action::text like 'ownership%' or action = 'operator_action'
order by id desc
limit 50;
```

**What the trail can't show:** a deletion or truncation refused by a trigger leaves only a server log line (`mygamedex owner protection: refused …`); a refusal repeated within 10 minutes is enforced but not recorded again; and nothing done by `postgres` or a superuser outside these functions is recorded at all.

## Infrastructure limitations

The database protects the Owner from application and API roles. It can't protect against people who hold the infrastructure keys:

- **`postgres` and superusers can bypass every protection.** They can disable triggers, use replica mode, edit the Owner record, the staff roles and the audit log, or drop them. Trust rests on who holds those credentials. `pgaudit`, named key holders and alerts on Owner changes are [launch prerequisites](../architecture/security-rls.md#production-launch-prerequisites-m8).
- **The Auth secret key** can remove factors, ban, change email or password, and delete users through the Admin API. Deleting the Owner is refused by a trigger and a foreign key, so Auth's deletion fails. The rest isn't in our audit log unless the operator records it.
- **The Supabase dashboard** gives project members the same powers. Limit membership, require MFA for it, and treat members as key holders.
- **The live MFA checks read Auth's internal tables** (`auth.sessions`, `auth.mfa_factors`, `auth.mfa_amr_claims`). If an Auth upgrade changes them, staff are locked out rather than exposed, and `owner_integrity()` reports `auth contract broken`. Opening, completing and cancelling a factor reset still work. Assigning an Owner and completing a reassignment refuse until the contract test (`31_auth_contract.test.sql`) passes again, so fix the contract first.
- **A TOTP code can be replayed for about 30 seconds** by someone who already holds a session. It doesn't defeat the 10-minute freshness window. It's a GoTrue limitation, and there's no custom TOTP implementation.
- **The database clock decides the timings.** The hold, maturity, freshness and expiry all use the database's `now()`.
