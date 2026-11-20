# M12c-B1 migration proposals (for review, not applied)

**Written for:** the reviewer of B1-M0, B1-M1 and B1-M2, before any of them moves to `supabase/migrations/`.

**Status, 2026-11-20 (checkpoint four):** final drafts for review. The short reviewer checklist is [SQL-REVIEW.md](SQL-REVIEW.md).
- **Checkpoint four:** two B1-M2 fixes (10 and 11 below), three more pgTAP tests. B1-M0 and B1-M1 unchanged.
- **Not applied** to development, the M12c-A test stack or the B1 stack.
- **Validated on a disposable scratch stack:** built fresh from the 72 current migrations, with these files applied from disk in order, then destroyed.
- **New in checkpoint three:**
  - withdrawing a single pairing (W1 to W9);
  - nine fixes: six to B1-M2, two to B1-M0 and one to B1-M1 (see Defects);
  - a B1-M2 rollback file;
  - a read-only B1-M0 preflight report;
  - 63 more pgTAP tests.

## Files

| Order | File | What | Rollback |
| --- | --- | --- | --- |
| — | `b1_m0_preflight_report.sql` | Read-only report on a target database, before B1-M0: alias conflicts B1-M0 would refuse, games that would come to share a key, and how many stored keys change | — |
| 1 | `20261210100000_m12c_b1_m0_unicode_title_keys.sql` | **B1-M0.** Title keys apply NFKC after mapping "™" and "℠" to a space, so "Ⅱ" is "II" (then 2), fullwidth letters are letters, and "Tetris™" stays "tetris". Only changed stored keys are recomputed. A preflight refuses alias-index collisions, and a NOTICE lists games that come to share a key (nothing is merged) | `….rollback.sql`: the previous bodies, its own alias preflight, the same recompute |
| 2 | `20261210100090_m12c_b1_m1_withdrawal_types.sql` | B1-M1, part 0: two audit actions (`catalog_pairing_withdrawn`, `catalog_pairing_restored`) | Not reversible; unused values are harmless |
| 3 | `20261210100100_m12c_b1_m1_identity_publication.sql` | **B1-M1.** Verified pairings, pairing origins, `verify_game_platform`, `publish_game_identity`, the publication invariant and public reads extended to identities, `exclusion_plan` keeping verified pairings (W9), and pairing withdrawal and restoration (W1 to W8) | `….rollback.sql`: refuses while identity-only publications exist |
| 4 | `20261210100200_m12c_b1_m2_review_batch_types.sql` | B1-M2, part 1: five audit actions | Not reversible; unused values are harmless |
| 5 | `20261210100300_m12c_b1_m2_review_batches.sql` | **B1-M2.** Policy, batches, items and approvals, immutability triggers, the exact sample-size function, and five editor functions | `….rollback.sql`: drops the five functions; the tables stay as history |
| | `tests/48_b1_unicode_title_keys.test.sql` | 25 pgTAP tests | |
| | `tests/49_b1_identity_publication.test.sql` | 58 pgTAP tests | |
| | `tests/50_b1_review_batches.test.sql` | 54 pgTAP tests | |
| | `tests/schema_guard_updates.patch` | The approved lists in `01_foundation`, `03_schema_guards`, `10_staff_and_functions` and `14_audit` gain the new tables, grants, `SECURITY DEFINER` functions and audit actions, nothing else | |

**Generated, not hand-retyped.** B1-M1 replaces five existing functions by exact signature:
- `search_catalog`;
- `get_release_picker`;
- `check_publication_of`;
- `catalog_game_platforms_json`;
- `exclusion_plan`.

Their bodies are the database's current definitions with marked substitutions (`-- B1-M1:` comments), each checked to match exactly once.

## Validation (fresh scratch stack, 2026-11-20)

| Run | Result |
| --- | --- |
| The five migrations, applied from disk in order | Applied without error |
| Full pgTAP: the existing 47 files with the guard patch, and 48, 49 and 50 | **3,852 / 3,852** (3,715 existing + 25 + 58 + 54; checkpoint four) |
| Existing behaviour tests unchanged, including `16_catalog`, `26_release_exclusion` and `46_flexible_ownership` | Pass. Each relaxation applies only to verified pairings |
| Database checks: catalog, search, import, release identity, ownership claims, collection, submission, review, relink, exclusion, merge, authorization, MFA | 13 suites, **786 / 786** |
| B1-M1 rollback with an identity-only publication present | **Refused**, nothing changed |
| Rollbacks in order: B1-M2, then B1-M1, then B1-M0 | Each applied. No B1 function remains, and `exclusion_plan` is byte-identical to its pre-B1 definition. The old key behaviour returns |
| B1-M0 after its rollback | Re-applied cleanly |
| B1-M0 with two aliases of one game that collide only once normalized ("Ⅱ" / "II") | **Refused**, and the preflight report named the pair |
| B1-M0 rollback with two aliases B1-M0 told apart ("Foo Ⅱ" / "Foo") | **Refused** by its own preflight; applied once the alias was removed |
| Data preservation: fixture titles with "Ⅱ", "Ⅲ", "II" and "™", fingerprinted before and after B1-M0 (every column except the derived keys, plus audit and title-key counts) | **Identical.** Only the keys changed: "Ⅱ" and "II" share `zqx keep 2`, "Ⅲ" is `zqx keep 3`, "™" adds nothing |
| Preflight report on development, the M12c-A test stack and B1 (read-only) | **0** alias conflicts, **0** games newly sharing a key, **0** stored keys changing on each. Nothing needs resolving before B1-M0 |
| `review_sample_size` | 138 (1,279, c = 0), 216 (c = 1) and 148 (10,000): the same as the JavaScript computation |

## Defects found and fixed in checkpoint three

| # | Draft | Defect | Fix |
| --- | --- | --- | --- |
| 1 | B1-M2 | **A withdrawn or rejected pairing could join a batch**, and approval would then publish it. Membership required only `status <> 'published'` | Members must be `unverified` or `under_review` (B10) |
| 2 | B1-M2 | **A sampled member marked "excluded" didn't count as a sample error**, so a failed sample could be passed by excluding what it found | Any sampled outcome other than "correct" is a sample error (B9) |
| 3 | B1-M2 | **Outcomes could be overwritten.** "Incorrect" could become "correct", a critical error could be cleared, and findings could change between the first and second approval | Findings only become more conservative, and are frozen once an approval exists (B9) |
| 4 | B1-M2 | **Three-valued logic.** The first version of fix 3 compared the old critical error to a null with `=`, so clearing it went through | `is not distinct from`; a pgTAP test caught it |
| 5 | B1-M2 | **The stale check looked at the game revision only.** A game or pairing leaving review without a revision change went unnoticed | Members must still be in review, with no game verification since freezing (B10) |
| 6 | B1-M2 | **Provenance was any Wikidata reference of the game**, and every batch-published pairing claimed `physical_eligibility: "confirmed"` | The frozen source record's provider, id and payload hash. "Confirmed" only for a member a person found correct; an unsampled member is `"batch_accepted"` (B11) |
| 7 | B1-M0 | **NFKC turns "™" into "TM"**, so "Tetris™" would have keyed as `tetristm` instead of `tetris` | "™" and "℠" become a space first, in both functions and the parser |
| 8 | B1-M0 | The rollback had no collision preflight; its NOTICE counted games wrongly | Preflight added; the NOTICE counts every game sharing the key |
| 9 | B1-M1 | **Excluding the last release of a reviewed identity cascaded to its verified pairing and the whole game** (`exclusion_plan` predates identities) | A verified pairing, and a game keeping one, stay published (W9) |
| 10 | B1-M2 | (Checkpoint four.) **A parser critical flag the SQL mapping didn't know carried no critical signal**: `external_ids_multiple`, new in the parser, would not have blocked approval | `review_critical_signal` maps it to `conflicting_identifiers`; the JS/SQL consistency test covers it |
| 11 | B1-M2 | (Checkpoint four.) **A batch-accepted game's verification audit rows didn't say it was batch accepted**: only the pairing basis did | Both `catalog_record_verified` rows carry `acceptance: individually_reviewed` or `batch_accepted` (B11) |

Checkpoint two had already fixed:
- a `normalize` syntax error;
- a missing audit reason;
- a batch function that failed when run twice in one transaction;
- a lost `$$`.

## Authorization matrix

Every function is `SECURITY DEFINER` with `search_path = ''`, executable by `authenticated` only, and checks the caller itself.
- **Staff privilege needs a second factor.** Any staff role is checked through `has_staff_role`, so an editor's session must be AAL2. "Recent" below means a TOTP verification in the last 10 minutes (`require_recent_mfa`).
- **No other role gets anything.** Anon, collectors, `catalog_importer` and `service_role` get no access to any new function or table. A collector's call is refused with `not permitted`, and anon's with `permission denied`.

| Function | Who | Second factor | Reason | Revision check | Independence |
| --- | --- | --- | --- | --- | --- |
| `verify_game_platform` | Catalog editor | Recent | Required | The game revision attested | Not the game's or the pairing's creator |
| `publish_game_identity` | Catalog editor | Recent | Required | The game's verification and each pairing's must attest the current revision | Not the game's or any pairing's creator |
| `get_pairing_withdrawal_preview` | Catalog editor | Session | — | Returns the revision to send back | — |
| `withdraw_game_platform` | Catalog editor | Recent | Required | Must match; the withdrawal moves it on | Only removes; refused under an active submission |
| `restore_game_platform` | Catalog editor | Recent | Required | Must match; moves it on | **Not the editor who withdrew it.** Returns to review, unverified |
| `create_review_batch` | Catalog editor | Recent | Required | Freezes each member's revision | The creator can't record outcomes or approve |
| `record_batch_outcome` | Catalog editor | Session | The outcome is the audit reason; the note goes in metadata | Batch open, no approval yet | Not the batch's creator; findings only become more conservative |
| `approve_review_batch` | Catalog editor | Recent | Required | Every member at its frozen revision and still in review | Not the batch's creator, not a member game's or pairing's creator, not twice. Above 1,000 members, a second, different approver |
| `reject_review_batch` | Catalog editor | Recent | Required | Batch open | Anyone, including the creator: rejection is conservative and final |
| `get_review_batch` | Catalog editor | Session | — | — | — |

## Invariants

**B1-M1, identity publication:**

| # | Invariant | Enforced by |
| --- | --- | --- |
| I1 | A pairing is published only with its game published, and a published release on it or an independent verification | `check_publication_of` (deferred constraint trigger) |
| I2 | A game is published only with a published release or a published, verified pairing | Same |
| I3 | A pairing verification records who, when, the game revision it attests, and its provenance, with `physical_eligibility: "confirmed"`. A Wikidata platform statement alone is never that confirmation | `require_pairing_basis`, a table check |
| I4 | No self-review: neither the game's nor the pairing's creator may verify the pairing or publish the identity | `created_by`, `pairing_created_by` |
| I5 | Revision-sensitive: publication needs the game's verification of its current revision, and each pairing's verification of that same revision | `verification_current`, `verified_game_revision` |
| I6 | Recent MFA | `require_recent_mfa`; `guard_pairing_publication` on the row |
| I7 | Identity publication never reads or writes a release | The functions; test 49 |
| I8 | The public sees a verified pairing with `release_count: 0`, and nothing about who verified it or why | No column grants on the new columns; `catalog_game_platforms_json` |

**B1-M1, pairing withdrawal:**

| # | Invariant | Enforced by |
| --- | --- | --- |
| W1 | An active catalog editor, a verification in the last 10 minutes, and a reason | `begin_catalog_edit`, `require_recent_mfa`, `require_reason` |
| W2 | Revision-sensitive. The caller names the game revision they reviewed. Withdrawal moves the revision on, so verifications at the earlier revision and open batches holding the game no longer count | `p_expected_game_revision`; the revision bump; I5; B4 |
| W3 | Never strands a release: refused while a release on the pairing is unverified, under review or published | `pairing_withdrawal_plan` (rechecked under lock) |
| W4 | Never strands a game: refused when a published game would be left with no published release and no other verified, published pairing | Same; `check_publication_of` at commit |
| W5 | No copy is changed | No code path writes `collection_items`; test 49 compares the claim row's hash |
| W6 | An immutable withdrawal row and an audit event. The pairing row is kept, excluded, with its verification cleared | `guard_pairing_withdrawal`; `record_catalog_audit` |
| W7 | No self-review bypass. Withdrawal only removes. Restoration is by a different editor and returns the pairing to review, unverified. Pairing it again or verifying it while withdrawn does nothing | `restore_game_platform`; `set_game_platform`'s `on conflict do nothing`; the status check in `verify_game_platform` |
| W8 | A pairing under an active submission is refused; the submission is reviewed instead | `pairing_withdrawal_plan` (`submitted_by`) |
| W9 | Excluding a release keeps a verified pairing, and a game keeping one | `exclusion_plan` substitutions |

**B1-M2, review batches:**

| # | Invariant | Enforced by |
| --- | --- | --- |
| B1 | Membership is frozen when the batch is created; only the outcome fields change, and only while the batch is open | `guard_review_batch_item` |
| B2 | The sample is reproducible: a seed drawn after the content is frozen, sha256 order, and a size computed in the database for the batch's actual unflagged count | `create_review_batch`, `review_sample_size` |
| B3 | Every flagged and every sampled member has a human outcome before approval | `approve_review_batch` |
| B4 | Approval is refused for any of these: <ul><li>the batch's creator, or the creator of any member game or pairing;</li><li>no recent MFA;</li><li>a failed sample, or a sampled member with a critical error;</li><li>an unresolved critical error;</li><li>a stale member (B10)</li></ul> | Same |
| B5 | A rejected batch is final; its members can join a new batch with a new seed | `guard_review_batch`, `reject_review_batch` |
| B6 | Above `second_approval_above` (default 1,000) a second, different approver is required. The pilot needs one | Policy row, approvals table |
| B7 | Approval publishes games and pairings only, never a release | `approve_review_batch`; test 50 |
| B8 | Every step writes an audit row: editor, batch, content hash, run, seed, sample, findings, decision. Audit rows are never edited | `record_audit`; the audit table's own guards |
| B9 | Findings only become more conservative. A recorded outcome changes only from incorrect to excluded, a recorded critical error is never cleared, and nothing changes once an approval exists. A sampled member that isn't correct is a sample error | `record_batch_outcome`, `approve_review_batch` |
| B10 | Members are only records still in review. A member is stale if its game revision changed, its game or pairing left review, or its game was verified since freezing | `create_review_batch`, `approve_review_batch` |
| B11 | A published pairing's provenance is its frozen source record. Physical eligibility is "confirmed" only for a member a person found correct, and `"batch_accepted"` for an unsampled one | `approve_review_batch` |

## When existing publications depend on a pairing

| Situation | What happens |
| --- | --- |
| A **published** release on the pairing | Withdrawal is **blocked**. The resolution is the reviewed M7b-2b exclusion of each release, which preserves every copy on it and can be restored by another administrator. Then withdraw |
| A release **under review or unverified** on it | **Blocked.** Reject, relink or exclude it first |
| **Rejected, excluded or merged** releases on it | Allowed. They keep pointing at the pairing, which is kept (excluded), so nothing is orphaned |
| **Collectors' claims** of the game on that platform, without a release | Allowed. The claims stay exactly as they are, since a claim depends only on the game being published. The count is recorded on the withdrawal |
| The pairing is the **last listed platform** of a published game | **Refused** (`last platform`). Excluding or merging the game is a game-level decision |
| The game is in an **open review batch** | Allowed. The batch becomes stale and can't be approved; it is rejected and the remaining members batched again |
| The pairing is under an **active submission** | **Blocked** until the submission is reviewed |
| The **last release of a reviewed identity** is excluded | The verified pairing and the game stay published (W9). An unverified pairing cascades as before |
| A release exclusion is restored while its pairing is withdrawn | Refused at commit: a published release needs its pairing published (I1, reverse rule). The pairing must first be restored to review, verified again and published |
| A withdrawal is restored | The pairing returns **to review, unverified**. It is published again only through an independent verification and publication, or a published release |

## Rollback behaviour

Run rollbacks in reverse order: B1-M2, then B1-M1, then B1-M0. Each is a forward migration in one transaction, so a refusal changes nothing.

| Migration | Rollback | Kept | Refuses when |
| --- | --- | --- | --- |
| B1-M0 | Restores the previous key functions and recomputes the same stored keys, without side effects (no revision, verification or audit change) | Every title, alias and other column | Two aliases of one game would collide under the old keys |
| B1-M1 | Drops the identity and withdrawal functions and the pairing-origin trigger, and restores the five replaced functions exactly | Verification columns, pairing origins and withdrawal rows, as history. A withdrawn pairing stays excluded | Any game or pairing is published only as an identity (published records can't be unpublished; exclude them first) |
| B1-M2 | Drops the five batch functions | Policy, batches, items and approvals, with their guards. Nothing published is unpublished. An open batch stays open, as a record of an unfinished review | — |
| Enum parts | Not reversible | Unused audit values | — |

Re-applying B1-M1 or B1-M2 after its rollback is a new forward migration, since their columns and tables are kept.

## Data preservation

- **Nothing deletes or rewrites a record.**
  - No B1 function deletes a game, pairing, release, copy, alias, verification or audit row.
  - Withdrawal keeps the pairing row (excluded) and copies its cleared verification into the withdrawal row.
  - Batches, items, approvals and withdrawals are insert-only apart from their one allowed change each, and are guarded against deletion.
- **No copy is touched.** No path writes `collection_items`: withdrawal is blocked while releases exist, and claims don't depend on pairings.
- **B1-M0 changes only derived keys.** Ids, titles, slugs, statuses, revisions, verifications and audit rows are unchanged (fingerprint above). Nothing is merged: the importer links only by external id, and a title match is held for review as a possible duplicate.
- **Publication stays reviewed.** Nothing publishes without the independence, revision and MFA checks above. Approval never creates, verifies or publishes a release.

## Open points for the reviewer

1. **The physical-eligibility wording for unsampled members** is now `"batch_accepted"` (fix 6). The alternative is to require individual confirmation for every pilot member, which the pilot's census-sized sample nearly is.
2. **Distribution formats (decided, checkpoint four).** The 12 formats the pilot states are classified in the parser's `DISTRIBUTION_FORMAT_TABLE`, from their fetched labels. A physical class only clears the "unclassified" flag and never establishes a physical release. Only a record whose every format for the platform is digital is held (`distribution_non_physical`); digital alongside physical is information only.
3. **Review flags.** B1's import step must copy each entry's flags into `payload.review_flags`, so `create_review_batch` sees them. The batch also recomputes date and title-collision flags itself.
4. **Pairing origins for API sessions.** An API session that isn't the pairing's submitter is recorded as `staff`, matching how pairings are created today (only editors and submitters can). A stricter check (`has_staff_role`) can be added.
5. **Staff pages** don't yet show pairing verification, withdrawal or batches (B1 step 5).
6. **Submitted games.** A game a collector submitted keeps the M7b-1 guard (`guard_submitted_record`), so identity publication doesn't bypass submission review while the submission is active.
