# M14c-3: approving batches and publishing identities in the admin panel

**Current status, 2026-11-23 (M15 P1a):** merged into `main` (PR #28) and applied to the local
development database (migration 82 of 82), after a backup, a cold snapshot and a rehearsal. Not
applied to the test stack, B1 or any hosted database. Nothing real was approved, rejected or
published. The first real SNES pilot runs on its own isolated stack ([catalog-pilot-m15.md](catalog-pilot-m15.md)), which doesn't exist yet. The command line now takes `MGD_STACK=b1` or `MGD_STACK=pilot`
explicitly. The status below is this document's original, kept as history.

**Written for:** whoever reviews or continues the catalog editorial workflow, and the operators
of a first real pilot. **Status, 2026-11-23:** on branch `m14c-3-approval-publishing`, validated on
a disposable scratch stack and in CI. Not applied to development, the test stack, B1 or any
hosted database. Nothing real was approved, rejected or published.

M14c-2 let editors review a batch's members in `/admin` ([catalog-review-ui-m14c2.md](catalog-review-ui-m14c2.md)).
This milestone completes the workflow: approving and rejecting batches, and publishing confirmed
game/platform identities, in the admin panel and in the B1 command line. **No business rule
changed.** `approve_review_batch` and `reject_review_batch` (M14c-1's and B1-M2's) and
`publish_game_identity` (M14a's) remain the only writers, unchanged.

The independent review found two races: one between what an editor saw and what approval or
publication then did, the other in publication. These are fixed by two thin wrappers that call
the writers unchanged, after one check under the same locks:
- `approve_review_batch_as_seen` refuses ("batch changed") unless the batch has exactly the
  approvals the editor saw. Without it, two editors who each saw "0 of 2" and were told "your
  approval would be recorded, the batch stays open" could both submit, and the second would make
  the final, publishing approval.
- `publish_game_identity_as_seen` refuses ("record changed") unless each chosen pairing is still
  verified exactly when the editor saw it. Confirming a pairing again replaces its evidence
  without changing the game's revision, which is all `publish_game_identity` checks.

The app and the CLI use only the wrappers. Both take the catalog edit lock, then the batch or the
game and its pairings, in the writers' own order, so neither can deadlock against them.

## What approval does (unchanged, now shown before it happens)

`approve_review_batch` refuses unless every flagged and sampled member has an outcome, the sample
passed, no critical error is unresolved, every member found correct has a qualifying evidence note,
no member is stale, and every source may still be published. It also refuses the batch's creator,
anyone who created or submitted a member, and anyone who already approved it, and it needs a recent
authenticator check. Then:

- **Not the final approval** (batches above the policy's size need two approvers): the approval is
  recorded, the batch stays open, outcomes are locked, and nothing is verified or published.
- **The final approval:**
  - members found correct have their identity verified and their physical existence confirmed
    with the reviewer's evidence. They are published, unless the final approver reviewed them;
    those wait for another editor to publish them;
  - unsampled members have their identity verified only: their pairing stays unconfirmed and
    unpublished;
  - members found incorrect or excluded are left as they are;
  - no release is ever created, verified or published.

Rejection closes an open batch for good, at any point before approval completes (also after a first
approval). Outcomes, approvals and audit rows are kept, and nothing is deleted. Unchanged members
can't be batched again without a real change.

## The batch page

`/admin/catalog/batches/[id]`, for an open batch, adds two sections below its readiness, progress
and provenance:

- **Approve the batch.** First, the database's prediction of what an approval by this editor would
  do now (`get_batch_approval_preview`):
  - "N of M approvals recorded", and whether this approval would be the final one;
  - each member's effect, counted and listable: confirmed and published, confirmed and waiting for
    another editor, confirmed without a verifier (its reviewer's account is gone, so nobody can
    publish it until it is confirmed again), confirmed at the final approval, identity verified
    only, not accepted, or still needing review;
  - members found correct without qualifying evidence;
  - each source's right to publish.

  It is labelled as a prediction: approval checks everything again when it runs. Without a
  preview there is no approval form. For an editor who can't approve, it says what the next
  approval would do. The form appears only when the database's assessment raises no blocker, the viewer may approve, and they verified
  with their authenticator in the last 10 minutes. It needs a written reason, the batch's first 8
  characters typed exactly, and an acknowledgement that says what this approval does. Its button
  says "Approve and publish", "Approve" (final, nothing to publish) or "Record my approval".
- **Reject the batch.** Visually apart, as a danger action. It explains that rejection is final for
  the batch and deletes nothing, and asks for the same three confirmations and a recent check.

**The decision action** (`decideBatch`, `src/features/batches/actions.ts`):
- It re-reads the batch, and sends nothing if the batch closed, or if the approvals or outcomes
  recorded differ from what the page showed. The editor reloads and checks again.
- Then it calls `approve_review_batch_as_seen` (or `reject_review_batch`) with the editor's own
  session. The database checks the approval count again under the batch's lock.
- A second approval by the same editor, two decisions at once, and a decision racing an outcome are
  refused by the database's row lock and rules. An app check races an approval against a
  rejection: exactly one wins.
- After an approval, the page shows what the database returned: either "1 of 2 approvals"
  recorded, or how many members were published, left waiting for an independent editor, and left
  waiting for physical evidence.
- A stale authenticator check sends nothing and goes to step-up, back to the page. Nothing is
  submitted for the editor.

## Publishing identities

The staff game record (`/admin/catalog/games/[id]`) adds **Identity publication**:
- **The game:** whether its identity is verified at its current revision.
- **Each platform pairing:**
  - its status;
  - whether its physical existence is confirmed, by whom (handle), when, with the evidence note;
  - whether it can be published now: already public, the reason it can't be, ready for you, or
    ready for another editor and why ("you confirmed its evidence", "you created this record").
  These come from `get_game_pairing_evidence`, which uses `publish_game_identity`'s own conditions.
- **The form:** shown only when the viewer may publish at least one platform, with a recent check.
  - Only those platforms get a box, and none is ticked.
  - It needs a written reason and a confirmation that the editor checked the evidence and didn't
    confirm it themselves.
  - It never publishes a platform that wasn't ticked, and never creates a release.

**The publish action** (`publishIdentity`, `src/features/publication/actions.ts`):
- It re-reads the record, and sends nothing if the game's revision changed, if a ticked platform
  is no longer one the viewer may publish (a forged one included), or if its evidence was confirmed
  again since the page showed it.
- It then calls `publish_game_identity_as_seen` with the editor's own session, the revision and
  each platform's evidence time they were shown.

## The publication queue

`/admin/catalog/publication` (linked from the catalog page and the batch pages) lists, 25 a page,
oldest first:
- pairings with a recorded physical-evidence basis;
- verified games whose pairing still lacks one.

They are grouped by state, with counts (`list_publication_queue`):

| State | What it means |
| --- | --- |
| Ready to publish | Each shown as "you may publish it", or why another editor must |
| Awaiting physical evidence | As every unsampled member of an approved batch is left |
| Evidence outdated | The evidence is for an earlier game revision |
| Verifier unavailable | The confirming account is gone |
| Blocked | The game's identity needs verifying again, or the pairing left review |
| Published | Already public |

A published game with another confirmed, unpublished platform is listed as ready. Each entry
links to the game record, where it is published.

## The migration: `20261213100000_m14c3_publication_reads`

It only adds to what's there, and is read-only (rollback in `supabase/rollbacks/`).

| Object | What |
| --- | --- |
| `game_platforms_physical_basis_idx` | Partial index on pairings with a basis, for the queue |
| `private.identity_publication_block(games, game_platforms)` | Why `publish_game_identity` would refuse a pairing now, in its order (as `get_game_pairing_evidence` says) |
| `private.identity_publication_own(uuid, uuid, uuid, uuid)` | The caller's own-record reasons (`you_confirmed`, `you_created`) |
| `public.get_batch_approval_preview(batch, limit)` | Each member's effect if the caller approved now; whether that would be final; counts; sources' rights; members with missing evidence. At most 200 members of each effect |
| `public.list_publication_queue(state, platform, after_at, after_game, after_platform, limit)` | One page of the queue, keyset `(at, game, platform)`, 1 to 100, with counts per state. Two branches, each through its own partial index (`game_platforms_physical_basis_idx`, `games_identity_verified_idx`); pairings that left review are not listed |
| `public.approve_review_batch_as_seen(batch, reason, expected_approvals)` | Approval, only if the batch still has the approvals the editor saw |
| `public.publish_game_identity_as_seen(game, platforms, reason, expected_revision, expected_verified_at[])` | Publication, only if each pairing is still verified when the editor saw it |

Both public functions are SECURITY DEFINER, STABLE, `search_path = ''`, start with
`require_active_staff('catalog_editor')`, and are executable by `authenticated` only. The helpers
are owner only. People appear by handle or "you".

**Fields returned:**
- **Preview:** `batch {id, status, content_sha256, items}`, `approvals {recorded, required}`,
  `final`, `counts {publish, await_publication, reviewer_gone, confirm, identity_only, not_accepted, pending}`,
  `evidence_missing`, `members [{game {id, title}, effect, reviewer, evidence_missing}]`,
  `sources [{provider, provider_name, cleared}]`.
- **Queue:** `status`, `counts {ready, awaiting_evidence, evidence_outdated, verifier_gone,
  published, blocked}`, `next_after {at, game, platform}`, and `items`. Each item:
  - `game {id, title, status, revision, slug}`;
  - `platform {id, slug, name, short_name}`;
  - `pairing_status`, `state`, `reason`, `at`;
  - `physical {source, reference, note, batch_id, verified_at, current, verifier}`;
  - `releases {total, published}`;
  - `you`.

## The command line: `publish`

`MGD_STACK=b1 node scripts/catalog-b1-review.mjs publish --email <editor>@example.test --game <id>`.
- **The editor's own session:** it signs in as that editor, with their password and a code from
  their own authenticator, typed by them.
- **What it shows:** each platform's evidence and whether they may publish it
  (`get_game_pairing_evidence`).
- **What it publishes:** only the platforms they type, with their reason, after they type the
  game's first 8 characters, at the revision they were shown.
- **The result:** it reports the database's answer as given (`reportPublish`: success only when
  `publish_game_identity` returned true).
- **Limits:** one game at a time, never a batch's list.

The tool's B1-only guard is unchanged: it refuses every other stack before connecting. Its
decisions live in `scripts/lib/publish-plan.mjs`, unit-tested in `scripts/publish-plan.test.mjs`.
It was never run against B1. The `approve` command now shows the database's preview first, and
its old text, which said approval publishes every member, is corrected.

## Tests

**pgTAP** `56_m14c3_approval_publishing`, 106 assertions:
- **Who may read:** visitors, collectors, editors without a verified factor and the service role
  are refused; helpers are owner only; both reads are STABLE.
- **A single-approval batch:** pending outcomes refused; the preview's counts equal approval's
  result exactly; the creator is refused; unsampled members stay unconfirmed and unpublished; no
  release is created; an approved batch can be neither approved nor rejected again.
- **Approved by its own reviewer:**
  - the confirmed members wait;
  - the queue says ready, for someone else;
  - the reviewer is refused when publishing their own evidence;
  - every item the queue calls ready is published when an independent editor asks, tried one at
    a time;
  - an identity is never a release;
  - unsampled members await evidence and are refused.
- **The queue's states:** an edited game (blocked); a verifier gone; a published game with a second
  platform confirmed, ready, outdated after an edit, refused at a stale expected revision, then
  published by another editor.
- **Two approvals:** the first records and waits, with nothing verified; a second approval by the
  same editor is refused; outcomes lock; the final approval publishes; only then is the batch
  approved; both are audited; approval rows can't be changed.
- **Rejection:** rejected with its reason; closed for every further decision and outcome; games
  and source records kept; unchanged members can't be batched again; rejected while waiting for
  reviews, and after a first approval, keeping that approval and publishing nothing.
- **Withdrawn rights:** the preview shows it, and approval refuses.
- **The queue's pages, counts, bounds and cursors.**
- **Agreement:** every listed pairing's reason equals `get_game_pairing_evidence`'s.

Tests 03 and 10 list the new functions. Baseline: 56 files, 4,432 assertions.

**Unit tests:** `npm run publication:test` (the decision and publish forms, their fixed messages
and notices) and `npm run catalog:test` (the CLI's publish plan).

**App** `app:publication-checks` (scratch only, 107 checks):
- **The empty queue.**
- **A two-approval batch:**
  - the preview, the form and its three confirmations;
  - a wrong prefix and a missing acknowledgement are refused;
  - the first approval leaves "1 of 2";
  - a duplicate post from an out-of-date page is refused;
  - no form for the editor who already approved, and the database refuses them directly;
  - outcomes lock;
  - the final approval's reported effects equal what happened.
- **Rejection:** a page read before an outcome changed is refused; a wrong prefix is refused; then
  rejected, with games and records kept.
- **A race:** approval against rejection; exactly one wins.
- **A stale authenticator check:** step-up, back to the page, nothing submitted.
- **Publication:**
  - the queue, for the reviewer and for others;
  - the reviewer gets no form, and the database refuses them;
  - nothing ticked, a forged platform and a missing confirmation are refused;
  - a page read before the game changed publishes nothing;
  - a collector posting the form publishes nothing;
  - an independent editor publishes; the game is public, as an identity with no release.
- **Outsiders:** collectors, visitors and direct calls.
- **In a real browser:** publishing with the keyboard only; native validation of the confirmation;
  the announced notice.
- **axe and layout:** WCAG 2.2 AA and no sideways scrolling on eight page states, at phone and
  desktop widths.

`app:a11y-checks` also audits the queue where the migration is present.

## Before a real SNES pilot (operator steps, not done here)

1. **Choose the target database** for the pilot (a fresh B1-style stack, or development), and keep
   it isolated from the persistent test stack.
2. **Bring it to the migration state:** all migrations through `20261213100000` (B1-M0 to M14c-3).
   The current B1 stack has 72, and its open batch `ae69e5d3…` has two `correct` outcomes without
   the evidence notes M14c-1 requires. That batch can't be approved after M14c-1. It is to be
   rejected and replaced, never edited or grandfathered.
3. **Designate the real, independent human editors:**
   - at least a batch creator, a reviewer and an approver who isn't the creator or any member's
     creator;
   - for publication of members the final approver reviewed, another editor;
   - for batches above the policy's size (1,000 members), two approvers who are neither the
     creator nor anyone who created a member.

   No agent acts as any of them.
4. **Give each one** an account, a handle, their own verified authenticator, and only the
   `catalog_editor` role, and confirm the role and MFA satisfy these rules.
5. **Confirm the source's publication rights:** Wikidata (CC0) cleared against the reviewed terms
   hash, and recorded as surviving withdrawal if intended (`record_provider_rights`).
6. **Re-stage the SNES candidates** from the saved, hashed source snapshot (never a new fetch
   presented as the old one).
7. **Create a new review batch** of the staged run (`create-batch`), so the sample is drawn fresh.
8. **Physical-evidence checks by a real person:** a human reviewer checks each flagged and sampled
   member against real physical evidence, and records every outcome with their own evidence note
   (M14c-1).
9. **Approve, then publish independently:** approve only when the database raises no blocker; then
   publish, by an independent editor, only the identities the database accepts.

Artwork is outside this workflow. ScreenScraper's developer-account approval does not establish
unrestricted public redistribution rights for box art, labels or disc artwork; nothing here
downloads, caches or publishes any.
