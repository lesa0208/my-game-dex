# M12c-B1 SQL review package

**For:** the independent SQL reviewer who approves B1-M0, B1-M1 and B1-M2 before any of them moves to `supabase/migrations/`.

**Status, 2026-11-20:** revised after the independent review of `62267d6` ("changes required"). These are unapplied drafts for a second review.
- Not applied to development, the M12c-A test stack or the B1 stack.
- Validated only on fresh, disposable scratch stacks, which were then destroyed.
- The full design and the earlier defect history are in [README.md](README.md). [INVENTORY.md](INVENTORY.md) lists every changed object and privilege.

## 1. Files, in apply order

Paths are relative to `docs/proposals/m12c-b1/`. The hashes are SHA-256 of the committed files.

| Order | File | SHA-256 | Changed since 62267d6 |
| --- | --- | --- | --- |
| Before | `b1_m0_preflight_report.sql` (read-only; run on the target first) | `b313fb4b…c592c` | Yes: finding 5 of the report |
| 1 | `20261210100000_m12c_b1_m0_unicode_title_keys.sql` | `cf2fa69d…280bf` | Yes: item 7 |
| 2 | `20261210100090_m12c_b1_m1_withdrawal_types.sql` (enum values, own transaction) | `58a99f4a…68693` | No |
| 3 | `20261210100100_m12c_b1_m1_identity_publication.sql` | `5c151e4a…68b0b` | Yes: RLS only |
| 4 | `20261210100200_m12c_b1_m2_review_batch_types.sql` (enum values, own transaction) | `1005afc6…fee67` | No |
| 5 | `20261210100300_m12c_b1_m2_review_batches.sql` | `d074a39d…2863a` | Yes: findings 1 to 7 |
| Rollback 5 | `20261210100300_m12c_b1_m2_review_batches.rollback.sql` | `b55e8b6a…0d8fd` | Comment only |
| Rollback 3 | `20261210100100_m12c_b1_m1_identity_publication.rollback.sql` | `901388f5…f7320` | Comment only |
| Rollback 1 | `20261210100000_m12c_b1_m0_unicode_title_keys.rollback.sql` | `17f0d344…02ad8` | Yes: orphan postcheck |
| Test 48 (25) | `tests/48_b1_unicode_title_keys.test.sql` | `1ab658e7…08b79` | No |
| Test 49 (58) | `tests/49_b1_identity_publication.test.sql` | `a48a804d…a832a60` | No |
| Test 50 (54) | `tests/50_b1_review_batches.test.sql` | `041fa4d9…dd645` | Fixture follows the new contract |
| Test 51 (45) | `tests/51_b1_review_hardening.test.sql` | `8d050155…dc13` | **New** |
| Two-session | `tests/concurrency/b1_concurrency_check.mjs` | `4384ae54…a774e` | **New** |
| Guard patch | `tests/schema_guard_updates.patch` | `b1d3561c…0ecb` | No (no new definer function or grant) |

Each file runs in one transaction (`psql -1 -v ON_ERROR_STOP=1`), so a refusal changes nothing.

## 2. The review findings: verdicts, changes and tests

Line numbers refer to the files at this commit.

| # | Finding | Verdict and evidence | Change | Regression test |
| --- | --- | --- | --- | --- |
| 1 | Batch approval concurrency (HIGH) | **Confirmed, and reproduced.** At 5c75321, `approve_review_batch` checked staleness without locks. With two real sessions, a member game edited by another transaction (row lock held until after the stale check) was still published. `b1_concurrency_check.mjs --demonstrate-defect` installs the old function under another name: it returned `approved` and published the edited game (revision 1 → 3) | M2 725–733: every member game, then every pairing, is locked `for update` in id order before the stale check. M2 773–803: each publication write is conditional on the frozen revision and review status, and a miss raises `batch stale`, so the whole transaction fails (B12) | `b1_concurrency_check.mjs`, 10 checks:<ul><li>edit first: the approval waits, fails `batch stale` and publishes nothing; the edit stands</li><li>approval first: the edit waits, the member is published at its frozen revision, and the edit lands after</li><li>the pre-fix defect is reproduced</li></ul> |
| 2 | No self-review in `record_batch_outcome` (HIGH) | **Confirmed.** It rejected only the batch's creator | M2 635–642: no outcome on a member whose game the caller created or submitted (`catalog_record_origins`, including submissions), whose game or pairing names the caller as submitter, or whose pairing the caller created. M2 697–701: approval also refuses a member game's submitter. The existing origin rules are unchanged | Test 51, 9 tests with three editors (e1 creates the batch, e3 created one member game and another member's pairing, e2 is independent). e3 is refused `correct` and even `excluded` on both; e2 records them; e3 can't approve; e2 can |
| 3 | MFA for review outcomes (HIGH) | **Partly disproved, then fixed.**<ul><li>Disproved: `begin_catalog_edit` → `require_active_staff` → `has_staff_role` already requires an aal2 session (`mfa_session_ok`, migration 20261116200000 lines 125–138), so aal1 was refused.</li><li>Confirmed: a *recent* verification was not required, unlike every other step</li></ul> | M2 615: `require_recent_mfa()` (B13) | Test 51, 3 tests: aal1 → `not permitted`; aal2 without a verification in 10 minutes → `reauthentication required`; recent aal2 → recorded |
| 4 | Sample shopping after a rejection (HIGH) | **Confirmed.** A rejected cohort could be re-batched unchanged with a new seed | M2 512–526: a member of a rejected batch joins a new batch only if its game revision moved (an audited edit, with its reason) or a new source record was staged. An entirely unchanged cohort is refused with `unchanged since rejection`. The count left out is in the creation audit row (B14) | Test 51, 5 tests: fail and reject, then the unchanged retry is refused; after an audited edit only the changed member joins; the audit row records 1 left out |
| 5 | End-to-end parser risk enforcement (HIGH) | **Confirmed.** `payload.review_flags` was optional, and an unknown flag carried no critical signal | <ul><li>M2 362–378: `review_flag_kind` lists every parser flag as exception or info; anything else is unknown.</li><li>M2 399–457: `review_risk_problems` validates contract `mgd-risk-assessment` v1: assessor, known and unique flags, critical signals exactly matching the flags, and provenance (provider, external id, source revision, the record's own run snapshot hash, full `payload.source`).</li><li>M2 528–534: one invalid or missing assessment refuses the whole batch (B15). Info flags are stored apart (`info_flags`) and don't make a member flagged.</li><li>The batch also recomputes `external_id_shared_in_batch` from the source ids.</li><li>Parser: `withRiskAssessment()` and `RISK_ASSESSMENT` in `scripts/wikidata-entities.mjs`</li></ul> | Test 51, 20 tests:<ul><li>missing, wrong version, unknown flag, omitted critical signal, malformed flags, wrong snapshot, no revision, no source detail: each refuses the batch; the validator names the problem;</li><li>info flags kept apart;</li><li>end to end through the M5b importer's own `start_run`, `stage_records`, `apply_record` and `finish_run`: the critical flag survives staging, the member is flagged and never sampled, approval waits, `correct` without evidence is refused, and the confirmed critical error blocks approval.</li></ul>`catalog-b1.test.mjs`, 3 tests: parser flag kinds equal SQL; the assessment shape; the pgTAP payload equals the parser's output |
| 6 | Provider licensing at publication (MEDIUM/HIGH) | **Confirmed.** Only the importer checked clearance | M2 142–210:<ul><li>`external_providers` gains `rights_survive_withdrawal`, `rights_terms_sha256`, `rights_note` and `rights_recorded_at`.</li><li>`record_provider_rights` (operators, owner only) records surviving rights only while the provider is cleared against those exact terms.</li><li>`require_publication_rights` takes a share lock and allows publication if the provider is cleared against the terms the record was imported under, or rights survive for those terms.</li><li>Checked at creation (M2 536–539) and at approval (M2 748–760) (B16)</li></ul> | Test 51, 5 tests:<ul><li>clearance withdrawn between staging and approval → refused, and no new batch;</li><li>cleared against new terms → refused;</li><li>surviving rights can't be recorded for uncleared terms;</li><li>rights recorded as surviving (CC0) → publishable after clearance ends</li></ul> |
| 7a | RLS on the new private tables | **Adopted** | M2 137–140 and M1 60, 901: RLS enabled, no policies, on all six | Test 51: RLS on six tables, 0 policies |
| 7b | Evidence for overriding risk signals | **Adopted** | M2 643–646: `correct` on a member with a critical signal needs a note of at least 20 characters. It is kept with the outcome and in the audit row (B17) | Test 51 (end to end): `looks fine` refused with `evidence required`. Test 50: the twin's `correct` now carries its evidence |
| 7c | Content hash coverage | **Adopted** | M2 568–575: the hash now covers:<ul><li>run and platform;</li><li>per member: game, revision, pairing status, source record, payload hash, risk-assessment digest, exception flags and info flags.</li></ul>It is versioned `mgd-review-batch:2` (B18) | Test 51: the stored hash equals an independent recomputation |
| 7d | `session_replication_role` in B1-M0 | **Verified supported, with a new guard.** Locally `postgres` is not a superuser but is a member of `supabase_privileged_role`, and `supautils.privileged_role_allowed_configs` includes `session_replication_role`. Hosted Supabase uses supautils the same way; confirm on the target. **Replica mode also skips foreign-key triggers**, so the drafts now check what they wrote | M0 22–31 (deployment note); M0 189 and 240–247, and rollback 116 and 167–172: a postcheck refuses any orphaned title key the step creates, compared with the count before. Preflight lines 19–21 and 64–70 report pre-existing orphans | Validation: M0 rolled back and re-applied with 7 pre-existing orphans present. Both succeeded, and none were added |
| 7e | Rollback is not a complete reversal | **Clarified** | M2 rollback header, M1 rollback header, M2 header: what is removed and what is kept as history | Inventory § "After the three rollbacks" |
| 7f | ZIP packaging | **Confirmed.** The `62267d6` "zip" was a tar archive. Git Bash's `tar.exe` is GNU tar, which ignores `-a` | This archive is built with PowerShell `Compress-Archive` and checked for the `PK` signature, then expanded and verified against its manifest | See the final report |

**Found during validation (pre-existing, outside B1):**
- **The suite's cleanup left orphaned title keys.** `db-ownership-claim-checks.mjs` deleted its synthetic games in replica mode without deleting their `game_title_keys`, leaving orphans.
  - The cleanup now deletes them and checks that none remain.
  - The read-only preflight finds 21 such orphans on the M12c-A test stack, and 0 on development and on B1. They are left untouched.
  - B1-M0 neither adds nor needs to remove them.

## 3. Authorization, function by function

Every new editor function is `SECURITY DEFINER` with `search_path = ''`, executable by `authenticated` only, and checks the caller itself. Anon, collectors, `catalog_importer` and `service_role` get nothing. Staff roles need an aal2 session. "Recent" means a TOTP verification within the last 10 minutes.

| Function | Migration | Caller | Second factor | Reason | Revision check | Independence |
| --- | --- | --- | --- | --- | --- | --- |
| `verify_game_platform` | M1 | Catalog editor | Recent | Required | Attests the current game revision | Not the game's or the pairing's creator |
| `publish_game_identity` | M1 | Catalog editor | Recent | Required | Game locked; its and each pairing's verification must attest the current revision | Not the game's or any pairing's creator |
| `get_pairing_withdrawal_preview` | M1 | Catalog editor | Session | — | Returns the revision to send back | — |
| `withdraw_game_platform` | M1 | Catalog editor | Recent | Required | Must match, then moves on | Only removes. Refused under an active submission |
| `restore_game_platform` | M1 | Catalog editor | Recent | Required | Must match, then moves on | Not the editor who withdrew. Back to review, unverified |
| `create_review_batch` | M2 | Catalog editor | Recent | Required | Freezes each member's revision, source record and assessment | The creator can't record outcomes or approve. Needs valid assessments (B15) and publication rights (B16); unchanged rejected members are left out (B14) |
| `record_batch_outcome` | M2 | Catalog editor | **Recent** (was: session) | The outcome; the note is the evidence, required to override a critical signal | Batch open, no approval yet | **Not the batch's creator, nor the member's game creator or submitter, nor its pairing's creator** (B13). Outcomes only become more conservative |
| `approve_review_batch` | M2 | Catalog editor | Recent | Required | **Members locked in id order, then checked; writes conditional on the frozen state** (B12) | Not the creator, nor any member's game creator or submitter, nor pairing creator, nor twice. A second approver above 1,000 members. **Publication rights rechecked** (B16) |
| `reject_review_batch` | M2 | Catalog editor | Recent | Required | Batch open | Anyone, the creator included. Rejection is final |
| `get_review_batch` | M2 | Catalog editor | Session | — | — | — |

The owner-only helpers can't be called by any client role:
- `review_flag_kind`, `review_critical_signal`, `review_risk_problems` and `review_sample_size` (with its maths);
- `record_provider_rights` and `require_publication_rights`;
- `pairing_withdrawal_plan`, `require_pairing_basis` and the guard triggers.

B1-M1 still replaces five existing functions by exact signature, with marked substitutions, and their grants are unchanged.

## 4. Invariants (summary)

Identity publication I1–I8 and withdrawal W1–W9 are unchanged; the README has them in full. Batches B1–B11 are as before, plus:
- **B12, concurrency:** approval locks the members, then checks them, and writes conditionally. A concurrent change fails the whole approval.
- **B13, no self-review per member:** outcomes need a recent second factor.
- **B14, no resampling:** members of a rejected batch return only after a verifiable change.
- **B15, a validated risk assessment:** every member needs one; missing, invalid or unknown flags refuse the batch, and info flags are kept apart.
- **B16, the right to publish:** rechecked at creation and approval, with surviving rights recorded per exact terms.
- **B17, evidence for overrides:** overriding a critical signal needs recorded evidence.
- **B18, a complete hash:** the content hash covers the complete frozen state.

## 5. Batch acceptance versus individual verification

| | Individually reviewed | Batch accepted |
| --- | --- | --- |
| Who | A sampled or flagged member a person reviewed and recorded as `correct` (with evidence if it had a critical signal) | An unflagged, unsampled member of a batch that passed its sample |
| Pairing `verification_basis.physical_eligibility` | `confirmed` | `batch_accepted` |
| `catalog_record_verified` audit rows (game and pairing) | `acceptance: individually_reviewed` | `acceptance: batch_accepted` |
| Provenance | The frozen provider record: `source`, `reference`, `snapshot_sha256`, `batch_id` | The same |
| Presented as independently human-verified | Yes | **No** |
| With any exception flag or critical signal | Needs its own outcome | Never batch accepted |

**Neither is evidence of a specific physical release.** A published game identity needs no barcode, region or packaging record. Releases stay individual, item-level editorial work (M11b-0, M12c-A), and approval never creates, verifies or publishes one.

## 6. Data preservation and rollback

- Nothing deletes or rewrites a record. B1-M0 changes only derived title keys, and now also proves it created no orphaned key. No path writes `collection_items`.
- Roll back in reverse order: B1-M2, then B1-M1, then B1-M0. Each rollback is a forward migration in one transaction. **None is a complete schema reversal.** They remove what can act and keep what holds history:

  | Migration | Removed | Kept |
  | --- | --- | --- |
  | B1-M2 | The five editor functions | Tables, guards, RLS, the provider-rights columns |
  | B1-M1 | Its functions and the trigger; the five replaced functions are restored byte-identically | Columns and history tables. **Refuses while any identity-only publication exists** |
  | B1-M0 | — (restores the old keys) | — **Refuses** if aliases would collide under the old keys |

- The enum values can't be removed.
- **Re-application:**
  - B1-M0 re-applies after its rollback.
  - B1-M1 and B1-M2 keep their tables, so re-applying them after a rollback needs a new forward migration.

## 7. Test outcomes (fresh scratch stacks, destroyed afterwards)

| Run | Result |
| --- | --- |
| The five drafts applied from disk, in order, on a fresh stack (72 migrations) | Applied |
| Full pgTAP: the 47 existing files with the guard patch, plus 48, 49, 50 and 51 | **3,897 / 3,897** (3,715 + 25 + 58 + 54 + 45) |
| 13 database suites (catalog, search, import, release identity, ownership claims, collection, submission, review, relink, exclusion, merge, authorization, MFA) | **786 / 786** |
| Two-session concurrency, with the pre-fix demonstration | **10 / 10** |
| B1-M1 rollback while identity-only publications exist | Refused, as designed |
| Second fresh stack: drafts applied, then rolled back M2, M1, M0 | Each applied. 0 B1 editor functions left; **0** pre-B1 objects missing or different |
| B1-M0 re-applied and rolled back again; and on a stack with 7 pre-existing orphaned keys | Applied each time; no orphan added |
| Tooling (`npm run catalog:test`) | **49 + 9**, 0 failed |
| Mutation-runner safety (`npm run mutation:guard-test`; the runner's offline self-tests) | **9 / 9**; **32 / 32** |
| Read-only B1-M0 preflight on development, M12c-A and B1 | 0 alias conflicts, 0 keys changing. Orphaned title keys: 0, 21 and 0 (see § 2) |
| Persistent stacks afterwards (read-only counts) | Unchanged: development 72 migrations, 19 games, 30 releases, 5 copies, 156 audit rows; M12c-A 72, 8, 30, 1, 79; B1 72 and empty |

## 8. Remaining design risks

1. **The risk assessment is only as complete as its assessor.** The contract proves the assessment is present, well formed, consistent and tied to its source. It can't prove the parser emitted every flag it should have.
   - Mitigation: the batch recomputes the date, title and external-id collision flags itself, and `assessor_version` is part of the hashed state.
   - A parser change that adds a flag fails CI until SQL knows the flag.
2. **Concurrency across batches.** Two batches can still be created over the same candidates at the same moment. Both are open until one is approved, and then the other is stale (B10, B12). Nothing is double-published; the stale batch is rejected and re-batched.
3. **`games.verified_at` has no basis column.** The acceptance kind is recorded on the pairing and in both audit rows. Staff pages (B1 step 5) must show the basis rather than "verified", and `get_pairing_withdrawal_preview` returns `verified: true` for both kinds.
4. **Surviving rights are an operator decision.** `record_provider_rights` is owner-only and audited, and it needs the provider cleared against the same terms. Whether a given licence survives termination is a legal judgement recorded with its note, not something the database can check.
5. **Pairing origins for API sessions** are still recorded as `staff` for any non-submitter (README open point 4).
7. **The real snapshot needs a re-fetch.** The risk assessment requires the source revision, and the 2026-11-20 snapshot of the 150 records was fetched without the `info` property, so `withRiskAssessment()` refuses every one. The fetch tooling now requests `info|labels|aliases|claims`. The same 150 frozen ids must be fetched again, in 3 requests, before the import.
6. **The pilot sample is close to a census.** `batch_accepted` matters at scale, and above 1,000 members two approvers are required.
