# M14c-1: physical-evidence notes and staff visibility

**Current status, 2026-11-23 (M15 P1a):** merged into `main` (PR #26) and applied to the local
development database (migration 80 of 82), after a backup, a cold snapshot and a rehearsal. Not
applied to the test stack, B1 or any hosted database. The first real SNES pilot runs on its own isolated stack ([catalog-pilot-m15.md](catalog-pilot-m15.md)), which doesn't exist yet. The status below is this
document's original, kept as history.

**Written for:** whoever reviews or continues the catalog editorial workflow. **Status,
2026-11-23:** on branch `m14c-1-physical-evidence`, validated on a disposable scratch stack and in
CI. Not applied to development, the test stack, B1 or any hosted database.

M14a made confirmed physical existence the only way a game is public without a published
release, and kept whoever confirms it from publishing it ([catalog-integration-m14a.md](catalog-integration-m14a.md)).
Its stated limitation: the evidence itself was optional free text, the batch path stored only
the provider record a member came from (a Wikidata listing is not evidence that a physical copy
exists), and no staff page showed what a pairing's verification rests on. This milestone closes
that gap. Its rules are unchanged.

## The migration

`20261211100000_m14c1_physical_evidence_notes` (rollback in `supabase/rollbacks/`):

| Change | What |
| --- | --- |
| `private.evidence_note_ok(text)` (new, owner only) | A note is evidence when, with surrounding and repeated whitespace collapsed, it has at least 20 characters, at least 10 of them letters or digits, and at most 500 (a basis note's limit) |
| `private.require_pairing_basis(jsonb)` (replaced) | `verify_game_platform`'s basis must carry such a `note`, as text. Its other rules are unchanged |
| `public.record_batch_outcome(...)` (replaced, same signature and grant) | A `correct` outcome needs such a note, not only one overriding a critical signal (B17), and at most 500 characters. `incorrect` and `excluded` keep optional notes up to 1,000 |
| `public.approve_review_batch(uuid, text)` (replaced, same signature and grant) | Refuses (`evidence required`) while any member found correct lacks such a note. Carries the reviewer's note into the pairing's basis, and audits the whole basis on the pairing's verification row |
| `game_platforms_physical_evidence_note` (new check, validated) | Every verification basis carries such a note, whichever path wrote it |
| `public.get_game_pairing_evidence(uuid)` (new, `authenticated`) | The staff read below |

Everything else in the three replaced functions is byte-identical to the reviewed versions (B1-M1,
B1-M2, M14a): MFA within 10 minutes, the expected revision, no self-review, independence of the
approver, the sample rules, rights rechecks, staleness and separation of duties.

**Existing data.** On 2026-11-23 no database had a verified pairing (development, the test stack
and B1 were checked read-only), so the table check is validated as it is added; a database that
has one fails the migration, and that pairing must be confirmed again with evidence. Outcomes
recorded earlier keep their notes. The open B1 batch `ae69e5d3…` has two `correct` outcomes with
no note: if this migration is ever applied there, that batch can't be approved. It would be
rejected and reviewed again, as for any finding that can't change (B9). There is deliberately no
check on the batch-item table itself: an account deletion sets `reviewed_by` to null, which would
re-check and block on those older rows.

**Constraint order.** PostgreSQL tests a table's checks in name order. The new check is named so
that M14a's `game_platforms_physical_evidence` is still the one reported for a basis without
confirmed eligibility.

## What a basis holds

| Key | Individual path (`verify_game_platform`) | Batch path (`approve_review_batch`) |
| --- | --- | --- |
| `source` | What the editor checked, as they write it (1 to 60) | The provider of the record reviewed (`wikidata`) |
| `reference` | Where (1 to 300) | That record's id (`Q…`) |
| `snapshot_sha256` | Optional | The record's payload hash at review |
| `physical_eligibility` | `"confirmed"`, nothing else | `"confirmed"` |
| `batch_id` | Optional | The batch |
| `note` | **Required:** the editor's evidence | **Required:** the reviewer's own outcome note |

The verifier is the pairing's `verified_by` (the reviewer in the batch path, never the approver),
with `verified_at` and `verified_game_revision`. Nothing generates a note: it is always what a
person typed. In the batch path, `source` and `reference` name the record the reviewer looked at;
the note is the evidence.

## The staff evidence section

`/admin/catalog/games/[id]`, section **Platforms and physical evidence** (it replaces the plain
platform list, which stays as the fallback when the evidence can't be loaded). One entry per
pairing, read-only:

- the platform, the pairing's status, and one of five states:
  1. **Physical existence not confirmed:** in review, no evidence.
  2. **Physical existence confirmed:** in review, evidence recorded, not public yet.
  3. **Published identity, no verified release:** public as an identity only.
  4. **Published, with a verified release:** public through a published release.
  5. **Not in review:** excluded, rejected or merged.
- Physical existence, evidence source, reference and note, the source snapshot, who verified it
  and when, its review batches (status, and whether the member was reviewed individually or left
  unsampled), the physical releases (recorded, and verified and published), and whether its
  identity could be published now, and by whom.

Nothing is inferred: a pairing without a basis shows no evidence, verifier or date; a release
counts only when it is verified and published; evidence recorded for an earlier revision of a game
still in review says it must be confirmed again before publication.

It uses the existing record components (`RecordSection`, `Facts`, `StatusBadge`), dark mode and
type scale: each pairing is an `article` with its own heading, and its facts a labelled list.

## Who can read it

`get_game_pairing_evidence` starts with `require_active_staff('catalog_editor')`: an active
account, the catalog editor or administrator role, and a session verified with the authenticator.
Visitors and the service role have no `EXECUTE`; collectors and aal1 staff sessions are refused.
Clients still have no column grant on `verification_basis`, and none on the review-batch tables.
The verifier is named by handle only (or "a former staff member"), as staff history already does;
no email address, account id or other person appears. The public game page is unchanged.

## Tests

- **pgTAP** `54_m14c1_evidence_notes` (84 assertions): what counts as a note; negative outcomes;
  an older correct outcome without evidence holding its batch; every refused note; propagation
  into the basis and its audit row; the verifier; unsampled members staying unverified and
  unpublished; the individual path; the table check; publication refusals; each state of the
  staff read; who may read it; collections and wishlists. Tests 49 to 51 and 53 now give their
  correct outcomes and bases an evidence note (their assertions are unchanged); 03 and 10 list the
  new function. Baseline: 54 files, 4,211 assertions.
- **App:** `app:catalog-identity-checks` signs a throwaway catalog editor in and checks both
  states, and that a collector, a visitor, the public page and direct API calls see none of it;
  `app:a11y-checks` audits both review states with axe at phone and desktop widths.

## Left for M14c-2 and M14c-3

Staff pages for review batches and recording outcomes: done in M14c-2
([catalog-review-ui-m14c2.md](catalog-review-ui-m14c2.md)). Left for M14c-3: approving and rejecting
batches and publishing in the UI, a `publish` step in `scripts/catalog-b1-review.mjs` for the second
editor, and choosing the two human editors and the database to publish on. No ScreenScraper integration and no artwork: artwork rights are kept
apart from evidence of physical existence.
