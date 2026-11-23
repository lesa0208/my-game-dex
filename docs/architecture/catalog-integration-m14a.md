# M14a Phase 1: B1 catalog integration

**Current status, 2026-11-23 (M15 P1a):** merged into `main` (PR #21) and applied to the local
development database, which has all 82 migrations on `main`. The test stack and B1 were not
migrated. Nothing real is approved or published. The first real SNES pilot runs on its own isolated stack ([catalog-pilot-m15.md](catalog-pilot-m15.md)), which doesn't exist yet. The status below is this document's
original, kept as history.

**Written for:** whoever reviews or continues the catalog pilot. **Status, 2026-11-22:**
technically integrated on the local branch `m14a-b1-integration` and validated on a disposable
scratch stack only. Not applied to development, the test stack, B1 or any hosted database.
Nothing real is approved or published.

## What was integrated

- **History:** `m12c-b0-catalog-sources` (B1, 11 commits) merged unchanged into `main` (`d0c2f12`)
  with a merge commit. `README.md`, `package.json` and `security-rls.md` merged without conflict.
- **Migrations,** in order after the already applied W1 wishlist migration (`20261207100000`,
  unchanged):

| Order | Migration | What |
| --- | --- | --- |
| 1 | `20261210100000_m12c_b1_m0_unicode_title_keys` | Title keys with NFKC (B1-M0) |
| 2 | `20261210100090_m12c_b1_m1_withdrawal_types` | Audit actions for pairing withdrawal |
| 3 | `20261210100100_m12c_b1_m1_identity_publication` | Verified pairings, identity publication, pairing withdrawal and restoration (B1-M1) |
| 4 | `20261210100200_m12c_b1_m2_review_batch_types` | Audit actions for review batches |
| 5 | `20261210100300_m12c_b1_m2_review_batches` | Review batches, sampling and approval (B1-M2) |
| 6 | `20261210100400_m14a_physical_evidence_gate` | **New in M14a:** the physical-evidence gate (below) |

  The five B1 files are byte-identical to the reviewed drafts, moved from
  `docs/proposals/m12c-b1/` (their comments still name that folder). Rollbacks are in
  `supabase/rollbacks/`, run newest first.
- **Tests:** B1's pgTAP files 48 to 51 moved to `supabase/tests/database/`. The inventory
  tests were reconciled: 01 and 10 by hand (B1's lists plus the wishlist's six functions and
  table), 03 and 14 from B1's patch. 50 and 51 follow the gate (stricter outcomes, below).

## The physical-evidence rule

My Game Dex catalogs physical games only. A game is public without a published physical
release only when its **physical existence** on a platform has been confirmed with evidence:

1. **Physical existence confirmed, no release catalogued yet:** an editor verified the
   pairing with a basis saying `physical_eligibility: "confirmed"`, with its source and
   reference (`verify_game_platform`), and a different editor published the identity
   (`publish_game_identity`). Shown as **"No verified physical release recorded yet"**.
2. **Physical existence not confirmed:** stays unpublished, however well a provider lists it.

B1-M2 originally also published *unsampled* batch members, recorded as `"batch_accepted"`:
public because Wikidata lists them and a sample of other members passed. The M14a gate takes
the alternative the B1 SQL review left open ([README, open point 1](../proposals/m12c-b1/README.md#open-points-for-the-reviewer)):

- Batch approval still verifies every accepted member's **identity**. Only members a person
  individually reviewed and found correct have their physical existence confirmed: their
  pairing is recorded as verified **by that reviewer**.
- **Whoever confirms the evidence never publishes it.** A reviewed member is published at
  approval only when the approver isn't its reviewer; otherwise it waits for another editor's
  `publish_game_identity`, which refuses anyone who verified the pairing. So the real pilot
  works with two people: editor B reviews and approves, editor A (the batch's creator)
  publishes. A third editor can approve and publish in one step.
- Unsampled members keep a verified identity, recorded as batch-accepted, but their pairing
  stays unverified and nothing of them is public. Each needs the individual path above.
- A table check makes every pairing's verification basis say `"confirmed"`, so every rule that
  treats a verified pairing as enough (the publication invariant, public reads and search,
  exclusion's W9, withdrawal's last-platform rule) rests on confirmed physical evidence.

Every way a game or pairing becomes public was checked: `publish_release` (through a published,
verified physical release: unchanged), `publish_game_identity`, `approve_review_batch`, and the
restorations (`restore_exclusion`, merges), which restore a previous status. All of them pass
`check_publication_of` at commit, which, with the table check, allows a public pairing without a
published release only on confirmed evidence. New pairings are always created `under_review`
(`set_game_platform`, the importer, submissions), and withdrawal clears a pairing's
verification; restoration returns it to review, unverified.

### What counts as evidence today

A pairing's `verification_basis`: `source` (1 to 60 characters), `reference` (1 to 300
characters), `physical_eligibility: "confirmed"` (nothing else is accepted), and optionally
`snapshot_sha256`, `note` (up to 500) and `batch_id`. It is recorded by a catalog editor who
didn't create the game or the pairing, with a second factor verified in the last 10 minutes,
against the game's current revision, and audited. Negative or inconclusive findings are
recorded as batch outcomes (`incorrect` or `excluded`, final once recorded) or by withdrawing
the pairing; they never verify anything.

**Resolved by M14c-1** ([catalog-evidence-m14c1.md](catalog-evidence-m14c1.md)): every basis now carries the editor's evidence note, and staff see it. The limitation as it stood: the basis is free text, and editors can't see it in the app (it has
no client grant and no staff page shows it). In the batch path, the stored reference is the
member's Wikidata record; the reviewer's own evidence is kept only in their optional outcome
note. The smallest next step: require an evidence note of at least 20 characters for every
`correct` outcome (as critical-signal members already need), carry it into the pairing's basis,
and show each pairing's basis, verifier and date read-only on the staff game page.

## Identity publication is not release verification

A published identity says only that the game exists physically on the platform. It never
implies an edition, region, publisher, format, packaging or product code: those come from a
verified, published release, which still needs its own verification and publication. Unsampled
members, held records and every record without evidence stay out of search, Game Details,
collections and wishlists.

## In the app

- **Explore:** a game with no verified release says "No verified physical release recorded
  yet", and its platform chips say "no verified release yet" instead of "0 releases".
- **Game Details:** the catalog's platforms and first release date, the message, and no
  release, shell or format. The existing add steps record a copy as the collector's own
  (unidentified) record; the existing wishlist offers game, platform and region wishes, never an
  exact release. No other screen changed.
- **Collection Statistics:** such a copy counts under its game and system, in its recorded
  region, with format "Not recorded".

## Compatibility checked

- **Wishlist (W1):** W1 accepts a platform wish only on a published pairing. B1 and the gate only
  narrow what is published, so W1's rule and B1's public platforms agree (every published release
  is verified: `releases_published_verified`). Wishes and copies survive exclusion, restoration
  and pairing withdrawal: statuses change, nothing is deleted.
- **Functions B1 replaces** (`search_catalog`, `get_release_picker`, `check_publication_of`,
  `exclusion_plan`, `catalog_game_platforms_json`, the title-key functions) were last defined
  before B1's base. W1, the only migration added since, touches none of them.

## Before the real editorial pilot

1. The gate's behaviour was approved by the product owner on 2026-11-22; the integration itself
   still goes through review and merge.
2. Choice of the two human editors (never an AI agent): one who reviews, confirms evidence and
   approves, and another who creates the batch and publishes what the first confirmed. And the
   first database to publish on.
3. Applying migrations 1 to 6 to that database with the forward process, after a verified backup.
4. Re-staging the SNES candidates there from the saved snapshot. The B1 stack keeps its own
   history and its open batch `ae69e5d3…` (3 of 116 outcomes), untouched.
5. The evidence improvement above (done in M14c-1: a required evidence note carried into the basis, and the
   basis shown on the staff game page), staff pages for pairings and batches (B1 step 5), and a
   `publish` step in `scripts/catalog-b1-review.mjs` for the second editor (it has none today).
