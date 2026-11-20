# M12c-B1 migration proposals (for review, not applied)

**Written for:** the reviewer of B1-M0, B1-M1 and B1-M2, before any of them moves to `supabase/migrations/`.

**Status, 2026-11-20:** drafts only.
- **Not applied** to development, the M12c-A test stack or the B1 stack.
- **Validated on a disposable scratch stack:** built from the 72 current migrations, with these four applied from disk in order, then destroyed.

| File | What | Rollback |
| --- | --- | --- |
| `20261210100000_m12c_b1_m0_unicode_title_keys.sql` | B1-M0: title keys normalize Unicode compatibility characters (NFKC), so "Ⅱ" is "II" (then 2), and fullwidth letters are letters. Recomputes only the stored keys that change. A preflight refuses alias-index collisions, and a report lists games that would come to share a key (nothing is merged) | `….rollback.sql`: the previous bodies, the same recompute |
| `20261210100100_m12c_b1_m1_identity_publication.sql` | B1-M1: verified pairings (`verified_at`, `verified_by`, `verified_game_revision`, `verification_basis`), pairing origins, `verify_game_platform`, `publish_game_identity`, and the publication invariant and public reads extended to identities | `….rollback.sql`: refuses while identity-only publications exist |
| `20261210100200_m12c_b1_m2_review_batch_types.sql` | B1-M2, part 1: five audit actions, in their own migration, as enum values must be | Not reversible; unused values are harmless |
| `20261210100300_m12c_b1_m2_review_batches.sql` | B1-M2, part 2: policy, batches, items and approvals, immutability triggers, the exact sample-size function, and five editor functions | Revoke execute on the five functions. The tables stay as history |
| `tests/48_b1_unicode_title_keys.test.sql` | 14 pgTAP tests | — |
| `tests/49_b1_identity_publication.test.sql` | 25 pgTAP tests | — |
| `tests/50_b1_review_batches.test.sql` | 32 pgTAP tests | — |
| `tests/schema_guard_updates.patch` | The approved lists in `01_foundation`, `03_schema_guards`, `10_staff_and_functions` and `14_audit` gain the new tables, function grants, `SECURITY DEFINER` functions and audit actions, nothing else | — |

**M1 and M2 are generated, not hand-retyped.** `search_catalog`, `get_release_picker` and `check_publication_of` are replaced by exact signature. Their bodies are the database's current definitions with marked substitutions (`-- B1-M1:` comments), each checked to match exactly once.

## Validation (scratch stack, 2026-11-20)

| Run | Result |
| --- | --- |
| All four proposals, applied from disk in order on a fresh stack | Applied without error |
| Full pgTAP: the existing 47 files with the guard patch, and 48, 49 and 50 | **3,786 / 3,786** (3,715 existing + 14 + 25 + 32) |
| Existing behaviour tests unchanged, including `16_catalog` and `26_release_exclusion`, which assert the publication invariants | Pass: the relaxation applies only to verified pairings |
| Database checks on the patched stack: catalog, search, import, release identity, ownership claims, collection, submission, review, relink, exclusion, merge, authorization, MFA | 13 suites, **786 / 786** |
| B1-M1 rollback, then B1-M0 rollback, then B1-M0 again | Each applied cleanly, with the expected keys at each step |
| `review_sample_size` | 138 (1,279, c = 0), 216 (c = 1) and 148 (10,000): the same as the JavaScript computation |

**Defects found and fixed during validation:**
- `pg_catalog.normalize(x, nfkc)` doesn't parse; `normalize(x, NFKC)` is SQL syntax.
- `record_batch_outcome` wrote an audit row without a reason, which `record_audit` refuses.
- `create_review_batch` couldn't run twice in one transaction (its temp tables are now dropped first).
- A `$$` lost in an edit of B1-M0's `do` block.

## Invariants

**B1-M1, identity publication:**

| # | Invariant | Enforced by |
| --- | --- | --- |
| I1 | A pairing is published only with its game published, and a published release on it or an independent verification | `check_publication_of` (deferred constraint trigger) |
| I2 | A game is published only with a published release or a published, verified pairing | Same |
| I3 | A pairing verification records who, when, the game revision it attests, and its provenance, with `physical_eligibility: "confirmed"`. A Wikidata platform statement alone is never that confirmation | `require_pairing_basis`, a table check |
| I4 | No self-review: neither the game's nor the pairing's creator may verify the pairing or publish the identity | `created_by`, `pairing_created_by` |
| I5 | Revision-sensitive: publication needs the game's verification of its current revision, and each pairing's verification of that same revision | `verification_current`, `verified_game_revision` |
| I6 | Recent MFA (10 minutes) | `require_recent_mfa`, and `guard_pairing_publication` on the row |
| I7 | Identity publication never reads or writes a release | The functions; test 49 |
| I8 | The public sees a verified pairing with `release_count: 0` and nothing about who verified it or why | Column grants (none on the new columns); `catalog_game_platforms_json` |

**B1-M2, review batches:**

| # | Invariant | Enforced by |
| --- | --- | --- |
| B1 | Membership is frozen when the batch is created; only the outcome fields change, and only while the batch is open | `guard_review_batch_item` |
| B2 | The sample is reproducible: a seed drawn after the content is frozen, sha256 order, and a size computed in the database for the batch's actual unflagged count | `create_review_batch`, `review_sample_size` |
| B3 | Every flagged and every sampled member has a human outcome before approval | `approve_review_batch` |
| B4 | Approval is refused for the batch's creator, for the creator of any member game or pairing, without recent MFA, on a failed sample, on an unresolved critical error, if a sampled member has a critical error, or if any member's revision changed | Same |
| B5 | A rejected batch is final; members can join a new batch with a new seed | `guard_review_batch`, `reject_review_batch` |
| B6 | Above `second_approval_above` (default 1,000) a second, different approver is required. The pilot needs one | Policy row, approvals table |
| B7 | Approval publishes games and pairings only, never a release | `approve_review_batch`; test 50 |
| B8 | Every step writes an audit row: editor, batch, content hash, run, seed, sample, findings, decision. Audit rows are never edited | `record_audit` calls; the audit table's own guards |

## RLS, grants and authorization

- **No client grants on new objects.** The new tables (`catalog_pairing_origins` and the four review tables) are in the private schema and revoked from every API role.
- **The new `game_platforms` columns** get no column grant, so anon and authenticated can't read them. The table uses column grants, and test 49 checks it.
- **Seven public functions**, each `SECURITY DEFINER` with `search_path = ''`, executable by `authenticated` only. Each checks the caller itself: `begin_catalog_edit()` (an active catalog editor), recent MFA where state changes, a reason, and the independence rules above.
- **The importer gains nothing.** `catalog_importer` can't verify, publish, create batches or record outcomes.

## Open points for the reviewer

1. **Excluding an identity-only pairing.** The M7b-2b exclusion plan cascades from releases. An identity with no release has no exclusion path yet, other than excluding the game. Add one before production, or accept the game-level exclusion.
2. **Review flags.** The importer stages the parser's payload as given. B1's import step must copy each entry's flags into `payload.review_flags`, so `create_review_batch` sees them. The batch also recomputes date and title-collision flags itself.
3. **Physical eligibility for unsampled members** is asserted by the batch's acceptance, recorded as `physical_eligibility: "confirmed"` with the `batch_id`, never as an individual check. Accept that wording, or add a distinct value such as `"batch_accepted"`.
4. **Pairing origins for API sessions.** An API session that isn't the pairing's submitter is recorded as `staff`, matching how pairings are created today (only editors and submitters can). A stricter check (`has_staff_role`) can be added.
5. **Staff pages** don't yet show pairing verification or batches (B1 step 5).
6. **Submitted games.** A game a collector submitted keeps the M7b-1 guard (`guard_submitted_record`), so identity publication doesn't bypass submission review while the submission is active.
