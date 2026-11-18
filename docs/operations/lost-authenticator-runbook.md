# Lost authenticator runbook

**Status:** written for M11a-1. Approved for now: **operator-assisted recovery only.** There's no self-service recovery, no automatic bypass, no administrator shortcut and no unverified factor reset, and this runbook doesn't authorize building one. It has been reasoned through against the local stack's behaviour (M11a-0); no hosted project exists. Before the beta, rehearse it on staging.

**Never put credentials, recovery codes, TOTP secrets, identity documents or a person's contact details into this repository, a ticket, a chat or the database.** A case reference is the only detail that goes into the database, in an operator action's reason.

## What losing an authenticator means here

These are facts about the current setup (Supabase Auth, GoTrue v2.197.0 locally; see [M11a-0](../architecture/architecture-decisions.md#adr-063-invitations-are-supabase-native-sent-with-a-server-only-secret-key-after-the-database-authorizes)):

| Fact | Consequence |
| --- | --- |
| A password sign-in gives a password-only session (aal1) | Without the authenticator, a person can still sign in, but every staff ability is refused: they all require a session verified with TOTP (`mfa_session_ok`) |
| Auth refuses to change the password of an account with a verified TOTP factor from an aal1 session (`insufficient_aal`) | They can't change their password, and a password reset stalls too: the recovery session is aal1. Since M11a-2 the reset page says so, asks for the authenticator, and tells someone who lost it to contact the operator: this runbook. Nothing in the app removes a factor |
| Removing a factor needs a TOTP-verified session | They can't remove the lost factor themselves |
| An operator can remove a factor with the Auth Admin API (secret key) | That's the only way out, and why it must be controlled |

## The people involved

| Role | Who |
| --- | --- |
| **Requester** | The person who lost their authenticator |
| **Approver** | The product owner, or for a staff member's case an administrator who isn't the requester; for an administrator's case, the Owner |
| **Operator** | A named person with the Auth secret key and a direct database connection. Never the requester, never the approver of the same case |

Every case has a written record kept **outside** the database: who asked, how identity was checked, the approval, each command run and its result, and the case reference.

## Before anything: identity verification

The operator removes nothing until identity is verified **through a channel the requester didn't choose for this request**:

1. The request arrives (any channel). Treat it as unverified, however convincing.
2. Contact the account holder **at the email address on the account**, from the operator's own client, not by replying to the request. Ask them to confirm the request and a detail only they'd know (for example, an item and its condition in their private collection, or when they joined), checked by the operator against the database without revealing it.
3. For staff, also confirm by voice or video with a second staff member who knows the person.
4. Record how identity was checked in the case file.

## Collectors

Collectors don't need an authenticator to use the app; staff do. A collector who enrolled one optionally and lost it can still sign in with their password and use their collection, but can't change their password or reset it.

1. Verify identity as above.
2. Approval: the product owner, in writing.
3. The operator lists the account's factors with the Auth Admin API and removes **only the verified TOTP factors the requester says they lost**, then records an operator action with the case reference: `select private.record_operator_action('<user id>', 'Lost authenticator removed, case <ref>, approved by <approver>', '{"operation": "factor_removed"}');`
4. Tell the requester at the account's email address that it was done and that they should enroll a new authenticator if they want one.

## Staff (catalog editors, moderators, administrators who aren't the Owner)

Staff can't work without an authenticator, so this is urgent, but it must not be rushed.

1. **Contain first.** Until identity is verified, assume the account might be compromised: an administrator (or, for an administrator, the Owner) may suspend it with the audited M8 function (`set_account_status`). Suspension doesn't remove anything.
2. Verify identity as above, including the second staff member.
3. Approval: an administrator who isn't the requester; for an administrator's case, the Owner (with Owner authority).
4. The operator removes only the lost factor, records the operator action as above, and reinstates the account if it was suspended for containment (audited).
5. The staff member enrolls a new authenticator in Settings → Security straight away. A new factor needs 24 hours to mature for Owner actions only; ordinary staff work needs one verified factor.
6. If the staff member had a second factor, nothing needs removing: they sign in with it and remove the lost one themselves.

## The Owner

The Owner's account has its own procedure, with holds, approvals and the succession document: follow the [Owner recovery runbook](owner-recovery-runbook.md) (Scenario A for one lost authenticator, B for both). **Never remove an Owner's factor with this runbook.** The Owner needs two mature factors for Owner authority, so a factor reset also pauses Owner authority for 24 hours after the new factors are registered.

## When to stop and escalate to manual review

Stop, record why, and don't remove anything if:

- identity can't be verified through the independent channel, or the account's email address was changed recently;
- the requester wants the operator to act now, without verification ("I'm the admin, just do it");
- the operator would be acting on their own account, or would approve their own case;
- the account is the Owner's, the successor's, or the target of a pending ownership transfer or recovery;
- there are signs of compromise (unknown sessions, an unexpected password change, a factor added recently that the person doesn't recognise);
- more than one factor would have to be removed and the person can't say which they lost.

Escalate to the product owner, and for staff keep the account suspended meanwhile.

## What this runbook doesn't do

- It doesn't disable MFA for anyone, or relax any M8 rule.
- It doesn't add a way to remove factors from the app.
- It doesn't replace a lost factor automatically.

Recovery UX and any further implementation are a separate decision.
