# M12c-B1 SQL review package

**For:** the independent SQL reviewer who approves B1-M0, B1-M1 and B1-M2 before any of them moves to `supabase/migrations/`.

**Status, 2026-11-20 (checkpoint four):** unapplied drafts.
- Not applied to development, the M12c-A test stack or the B1 stack.
- Validated only on fresh, disposable scratch stacks, which were then destroyed.
- The full design, the invariant tables and the defect history are in [README.md](README.md). This page is the short checklist.

## 1. Files, in apply order

Paths are relative to `docs/proposals/m12c-b1/`. The hashes are SHA-256 of the files in this checkout.

| Order | File | SHA-256 |
| --- | --- | --- |
| Before | `b1_m0_preflight_report.sql` (read-only report; run on the target first) | `5e707dfa…d27f0` |
| 1 | `20261210100000_m12c_b1_m0_unicode_title_keys.sql` | `2367daa2…c1870` |
| 2 | `20261210100090_m12c_b1_m1_withdrawal_types.sql` (enum values; its own transaction) | `58a99f4a…68693` |
| 3 | `20261210100100_m12c_b1_m1_identity_publication.sql` | `5e758864…2bce` |
| 4 | `20261210100200_m12c_b1_m2_review_batch_types.sql` (enum values; its own transaction) | `1005afc6…fee67` |
| 5 | `20261210100300_m12c_b1_m2_review_batches.sql` | `ed78f2ae…47e8` |
| Rollback 5 | `20261210100300_m12c_b1_m2_review_batches.rollback.sql` | `feaf5509…29c3a2` |
| Rollback 3 | `20261210100100_m12c_b1_m1_identity_publication.rollback.sql` | `419495d5…e10c` |
| Rollback 1 | `20261210100000_m12c_b1_m0_unicode_title_keys.rollback.sql` | `d631923f…7fd5` |
| Tests | `tests/48_b1_unicode_title_keys.test.sql` (25), `tests/49_b1_identity_publication.test.sql` (58), `tests/50_b1_review_batches.test.sql` (54) | `1ab658e7…b79`, `a48a804d…a832a60`, `4ee91413…b300361` |
| Guard patch | `tests/schema_guard_updates.patch` (the approved lists in tests 01, 03, 10 and 14) | `b1d3561c…0ecb` |

Each file runs in one transaction (`psql -1 -v ON_ERROR_STOP=1`), so a refusal changes nothing.

## 2. Changes since checkpoint three (SQL)

Both changes are in B1-M2. B1-M0 and B1-M1 are byte-identical to `300fe5b`.

| # | Defect demonstrated | Change | Test |
| --- | --- | --- | --- |
| 10 | The parser now flags records that carry several IGDB or MobyGames ids (`external_ids_multiple`). Without a mapping, `review_critical_signal` returned null for that flag. A batch would then approve the record without its critical gate, as long as the flag was the record's only signal | `review_critical_signal` maps `external_ids_multiple` to `conflicting_identifiers`. The JavaScript and SQL mappings are kept equal by a test | Test 50: one new assertion. Test `catalog-b1`: JS/SQL consistency |
| 11 | Batch approval stamped `games.verified_at` and `verified_by`, and wrote both `catalog_record_verified` audit rows, with nothing saying whether the member was reviewed individually or only accepted with the batch. Only the pairing's `verification_basis` recorded `batch_accepted`. That contradicts the product rule that batch-accepted metadata is never labelled as independently human-verified | Both audit rows (game and pairing) now carry `acceptance: "individually_reviewed"` or `"batch_accepted"` | Test 50: two new assertions (B11) |

## 3. Authorization, function by function

Every new function has these properties:
- it is `SECURITY DEFINER` with `search_path = ''`;
- it is executable by `authenticated` only;
- it checks the caller itself.

Anon, collectors, `catalog_importer` and `service_role` get nothing. Staff roles need an AAL2 session. "Recent" means a TOTP verification within the last 10 minutes.

| Function | Migration | Caller | Second factor | Reason | Revision check | Independence |
| --- | --- | --- | --- | --- | --- | --- |
| `verify_game_platform` | M1 | Catalog editor | Recent | Required | Attests the current game revision | Not the game's or the pairing's creator |
| `publish_game_identity` | M1 | Catalog editor | Recent | Required | The game's and each pairing's verification must attest the current revision | Not the game's or any pairing's creator |
| `get_pairing_withdrawal_preview` | M1 | Catalog editor | Session | — | Returns the revision to send back | — |
| `withdraw_game_platform` | M1 | Catalog editor | Recent | Required | Must match, then moves on | Only removes. Refused under an active submission |
| `restore_game_platform` | M1 | Catalog editor | Recent | Required | Must match, then moves on | Not the editor who withdrew. Returns the pairing to review, unverified |
| `create_review_batch` | M2 | Catalog editor | Recent | Required | Freezes each member's revision | The creator can't record outcomes or approve |
| `record_batch_outcome` | M2 | Catalog editor | Session | The outcome itself | Batch open, no approval yet | Not the creator. Outcomes only become more conservative |
| `approve_review_batch` | M2 | Catalog editor | Recent | Required | Every member at its frozen revision and still in review | Not the creator, nor any member's game or pairing creator, nor twice. A second approver above 1,000 members |
| `reject_review_batch` | M2 | Catalog editor | Recent | Required | Batch open | Anyone, the creator included. Rejection is final |
| `get_review_batch` | M2 | Catalog editor | Session | — | — | — |

Five private helpers are executable by no role, and are called only from the functions above:
- `pairing_withdrawal_plan`;
- `review_critical_signal`;
- `review_sample_size`;
- `require_pairing_basis`;
- the guard triggers.

B1-M1 also replaces five existing functions by exact signature, with marked, generated substitutions:
- `search_catalog`;
- `get_release_picker`;
- `check_publication_of`;
- `catalog_game_platforms_json`;
- `exclusion_plan`.

## 4. Publication and withdrawal invariants (summary)

The full statements and their enforcement are in the README's Invariants section.

**Identity publication (I1 to I8):**
- A pairing is published only with its game, and with a published release or an independent verification.
- A game is published only with a published release or a published, verified pairing.
- A verification records:
  - who;
  - when;
  - the revision it attests;
  - its provenance.
- A Wikidata platform statement alone is never a verification.
- No self-review, a recent second factor, and no release is ever read or written.
- The public sees `release_count: 0`, and nothing about who verified a pairing or why.

**Withdrawal (W1 to W9):**
- It needs a reason and a recent second factor, and it is revision-checked.
- It never strands a release or a published game, and never changes a copy.
- It leaves an immutable withdrawal row and an audit event.
- Restoration is by a different editor and returns the pairing to review, unverified.
- Excluding a release keeps a verified pairing.

**Batches (B1 to B11):**
- Membership is frozen, and the sample is reproducible and sized in the database.
- Every flagged and every sampled member gets a human outcome.
- Approval is refused in each of these cases:
  - the approver created the batch, a member game or a member pairing;
  - the approver has no recent second factor;
  - the sample failed;
  - a critical error is unresolved;
  - a member is stale.
- Findings only become more conservative.
- Approval publishes games and pairings, never releases.

## 5. Batch acceptance versus individual verification

| | Individually reviewed | Batch accepted |
| --- | --- | --- |
| Who | A sampled or flagged member that a person reviewed and recorded as `correct` | An unflagged, unsampled member of a batch that passed its sample |
| Pairing `verification_basis.physical_eligibility` | `confirmed` | `batch_accepted` |
| `catalog_record_verified` audit rows (game and pairing) | `acceptance: individually_reviewed` | `acceptance: batch_accepted` |
| Its provenance | The frozen provider record (`source`, `reference`, `snapshot_sha256`, `batch_id`) | The same |
| Presented as independently human-verified | Yes | **No** |
| Eligible with any critical signal | No: every flagged member needs its own outcome | No: a flagged member is never batch accepted |

Neither status is evidence of a specific physical release. Releases stay individual editorial work (M11b-0, M12c-A), and approval never creates one.

## 6. Data preservation and rollback

- Nothing deletes or rewrites a record. B1-M0 changes only derived title keys. On scratch, a fingerprint of every other column, plus the audit and key counts, was identical before and after.
- No path writes `collection_items`.
- Roll back in reverse order: B1-M2, then B1-M1, then B1-M0. Each rollback is a forward migration in one transaction:
  - **B1-M2:** drops the five batch functions. The batch tables stay as history.
  - **B1-M1:** refuses while any identity-only publication exists. It then restores the five replaced functions byte-identically.
  - **B1-M0:** refuses if aliases would collide under the old keys.
- The enum parts can't be reversed. Unused enum values are harmless.
- Before B1-M0, run `b1_m0_preflight_report.sql` read-only on the target. Development, the M12c-A test stack and B1 each report 0 conflicts and 0 key changes.

## 7. Test outcomes (checkpoint four, fresh scratch stack, then destroyed)

| Run | Result |
| --- | --- |
| The five drafts applied from disk in order | Applied |
| Full pgTAP: 47 existing files with the guard patch, plus 48, 49 and 50 | **3,852 / 3,852** |
| 13 database check suites (catalog, search, import, release identity, ownership claims, collection, submission, review, relink, exclusion, merge, authorization, MFA) | **786 / 786** |
| Rollbacks M2, M1, M0 in order | Each applied. No B1 function remains |
| Tooling tests (`npm run catalog:test`) | **46 + 9**, 0 failed |
| Persistent stacks afterwards (read-only counts) | Unchanged: development 72 migrations, 19 games, 30 releases, 5 copies, 156 audit rows. M12c-A 72, 8, 30, 1, 79. B1 72 and empty |

## 8. Remaining design risks for the reviewer

1. **Flags must reach the batch.** The import step (not yet written) must copy each entry's flags into `payload.review_flags`. Otherwise `create_review_batch` sees only the date and title-collision flags it recomputes itself. The import implementation needs a test that a parser critical flag blocks approval end to end.
2. **Unknown flags fail open for criticality.** A flag the SQL mapping doesn't know still makes a member "flagged", so it needs an individual outcome and is never batch accepted. However, it carries no critical signal. A test keeps the two mappings equal, so a new parser flag fails CI until SQL maps it. The alternative is to treat unmapped flags as critical.
3. **`games.verified_at` has no basis column.** The acceptance kind is in the audit trail and on the pairing, not on the game row. Staff pages (B1 step 5) must show the pairing basis, not "verified", for batch-accepted records. `get_pairing_withdrawal_preview` returns `verified: true` for both kinds.
4. **The pilot sample is close to a census.** With 150 members and so many flags, most members get an individual outcome anyway. `batch_accepted` matters at scale: above 1,000 members, two approvers are required.
5. **Pairing origins for API sessions** are recorded as `staff` for any non-submitter (README open point 4).
6. **Submitted games** keep the M7b-1 guard, so identity publication can't bypass an active submission review.
7. **RLS on the new private tables is off.** This matches the existing private catalog tables, `catalog_record_origins` and `catalog_verifications`. The six tables have no grants and `private` has no `USAGE` for client roles, so only the definer functions reach them. Enabling RLS with no policies is a defense-in-depth option that would leave the functions unaffected. See [INVENTORY.md](INVENTORY.md).

## 9. Inventory

[INVENTORY.md](INVENTORY.md) lists every changed object and privilege. It was generated from a fresh scratch catalog read before B1, after B1 and after the rollbacks:
- 24 new and 7 replaced functions;
- 10 new functions for `authenticated`, and none for `anon`, `service_role`, `catalog_importer` or `PUBLIC`;
- 0 table or column grant changes;
- after the rollbacks, nothing missing or different from pre-B1.
