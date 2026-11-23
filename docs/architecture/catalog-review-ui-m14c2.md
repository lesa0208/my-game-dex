# M14c-2: review batches in the admin panel

**Written for:** whoever reviews or continues the catalog editorial workflow. **Status,
2026-11-23:** on branch `m14c-2-catalog-review-ui`, validated on a disposable scratch stack and in
CI. Not applied to development, the test stack, B1 or any hosted database.

B1-M2 froze imported game identities into review batches, with their flags, a random sample and
the rules for recording outcomes and approving ([catalog-ingestion-m12c-b1.md](catalog-ingestion-m12c-b1.md)).
M14a made confirmed physical existence the only way a member is published, and M14c-1 made every
"correct" outcome carry its reviewer's physical evidence ([catalog-evidence-m14c1.md](catalog-evidence-m14c1.md)).
Until now, reviewing a batch took SQL or the command-line reviewer (`scripts/catalog-b1-review.mjs`).
This milestone lets a catalog editor review a batch's members in `/admin`. **Approving, rejecting
and publishing stay out of the UI** (M14c-3): approval can publish identities under M14a's rules.

## Pages

| Page | What it shows |
| --- | --- |
| `/admin/catalog/batches` | Batches, newest first, 25 a page, filtered by status (open by default, approved, rejected, all) and platform. Each: id, platform, source run and provider, creation date, creator by handle, status, members, flagged and sampled counts, reviews recorded of required and pending, critical signals and recorded critical errors, approvals recorded of required |
| `/admin/catalog/batches/[id]` | The batch: status, platform, creator; **approval readiness** (the database's blockers, approvals and why the viewer couldn't approve); **review progress** (recorded of required, outcomes, critical errors, sample errors against the acceptance number); **provenance and sampling** (source, fetch and finish times, snapshot hash, terms hash, frozen content hash, seed, member categories, sample size, policy, required reviews, reason); **members**, 25 a page, filtered with counts |
| `/admin/catalog/batches/[id]/members/[game]` | One member: category, outcome and statuses; flags with why each matters; possible critical errors; the catalog record; **game identity evidence**, **physical existence evidence** and **physical release evidence**, kept apart; the outcome form or why there is none; review history |

The catalog page links to the batch list, and the game record's evidence section links each
batch it lists. Every page calls `requireAdminSection(path, "editor")`: catalog editors and
administrators, with a verified authenticator session (staff without one verify first; others get
a not-found page). Each says plainly that accepting an identity from a source is not proof that a
physical copy exists.

### Member categories and order

Each member is in one category, from its frozen fields: **critical risk** (flagged, with a critical
signal), **flagged**, **sampled**, or **not sampled** (accepted with the batch only if the sample
passes, never reviewed individually, and on approval left with a verified identity and an
unconfirmed, unpublished pairing). Members are listed critical first, then flagged, sampled and
not sampled, each by its source record's title (frozen with the batch). The member filters are: awaiting review (default while any is
pending), critical risk, flagged (critical included), sampled, reviewed, not sampled, and all.

### The three kinds of evidence

- **Game identity evidence:** the source record (provider, id, staged revision, linked), its
  titles, first release, the release on the batch's platform, what it's typed as, platforms
  stated, IGDB and MobyGames ids, whether the full entity record was staged, the risk assessment
  and its problems, the record and snapshot hashes, and possible duplicates and conflicts (catalog
  games with the same title key, members sharing an IGDB or MobyGames id, other games linked to the
  same source id). It says nothing about whether a physical copy exists.
- **Physical existence evidence:** whether an editor has confirmed it with evidence (a platform
  listing or a stated format never counts), the formats the source states with their
  classification, and the evidence recorded in this batch (a correct outcome's note) or that
  there is none.
- **Physical release evidence:** releases recorded on the platform, and how many are verified and
  published. A batch never creates or verifies a release.

## Recording an outcome

The form appears only when the database's assessment says the viewer may record one (below), the
member isn't stale, and the viewer verified with their authenticator in the last 10 minutes
(otherwise it asks them to verify, and they come back to the page). It offers only the outcomes
the database would accept: all three, or only "excluded" for a member found incorrect, keeping its
critical error.

- **Nothing is chosen or written for the editor.** No outcome is preselected (unless only one is
  possible), and the note is never filled in.
- **Correct** needs the editor's physical evidence: the form explains what is expected, checks
  live what the database will refuse (20 to 500 characters, 10 of them letters or digits), shows
  the source and reference that approval records beside it, and keeps the note exactly as typed.
  It takes no critical error.
- **Incorrect** and **excluded** keep their optional notes (up to 1,000 characters) and take one
  of the seven critical-error categories, or none.
- **Every outcome needs its confirmation box**, which says what the outcome means and that it is
  final (incorrect can later only become excluded; nothing else changes it but rejecting the batch).

`recordOutcome` (`src/features/batches/actions.ts`) sends `record_batch_outcome` with the editor's
own session. It first re-reads the member and sends nothing if the page is out of date (the
member's outcome or game revision changed) or the database's assessment says the viewer can't
record one. Everything else is the database's: role, recent authenticator check, batch state,
self-review, evidence, and that findings only become more conservative. A duplicate or concurrent
submission is refused by the database's row lock and B9 ("outcome recorded"), except the one change
B9 allows: two tabs from one page view can record "incorrect" and then "excluded", which only makes
the finding more conservative. The action also refuses a member that is stale (a UI rule, stricter than
`record_batch_outcome`: such a batch can't be approved). Without JavaScript, every field is in the
served form, and a refusal comes back to the member as a fixed message's code in the URL. A stale
authenticator check never works around: the note is kept in the tab while the editor verifies, and
they submit again. Messages are fixed; nothing from the database reaches the page. Server actions
check the request's origin (Next.js), so a cross-site form can't post one.

## The migration

`20261212100000_m14c2_review_batch_reads` (rollback in `supabase/rollbacks/`). Additive and
read-only: nothing it adds writes, and nothing changes who may record, approve, reject or publish.

| Object | What |
| --- | --- |
| `catalog_review_batches_created_idx` | `(created_at desc, id desc)`, for the list's keyset |
| `private.review_member_rank(boolean, text[], text[])` | A member's category (0 to 3) from frozen fields |
| `private.json_safe_strings(jsonb, text, integer, integer)` | Up to N strings of a JSON array matching a whole-string pattern and length; anything else left out |
| `private.review_source_summary(jsonb)` | The allow-listed fields of a source payload (below) |
| `private.review_external_keys(jsonb)` | A payload's IGDB and MobyGames ids, as `create_review_batch` compares them |
| `private.review_person(uuid, uuid)` | `{handle, you}` for a person, null once the account is gone |
| `public.list_review_batches(p_status, p_platform, p_after, p_limit)` | One page of batches |
| `public.get_review_batch_overview(p_batch)` | One batch, its counts and blockers |
| `public.list_review_batch_members(p_batch, p_filter, p_after, p_limit)` | One page of members |
| `public.get_review_batch_member(p_batch, p_game)` | One member's review context |

The four public functions are SECURITY DEFINER, STABLE, `search_path = ''`, and start with
`require_active_staff('catalog_editor')`. Only `authenticated` may execute them (not `anon`,
`service_role` or `PUBLIC`); the helpers are owner only.

**Pagination.** Pages hold 1 to 100 (25 in the app); anything else is refused (`invalid changes`).
The cursor is the last row's id: a batch for the list, a member's game id for members. A cursor
that isn't one is refused (`invalid cursor`), never guessed. One row past the page is read only to
know whether another follows. Batches are ordered `(created_at desc, id desc)`; members
`(category, source record title, game id)`, all frozen with the batch (source records can't
change), so neither recording an outcome nor editing a game moves a member, and a pending member is
never skipped or shown twice.

**Assessments, not decisions.** `blockers` lists what `approve_review_batch` would refuse now, in
its order: `pending_outcomes`, `sample_failed`, `critical_errors_unresolved`, `evidence_missing`,
`stale`, `publication_rights` (each with how many members or sources cause it). `you.review`,
`you.approve` and the member's `you.record` follow `record_batch_outcome`'s and
`approve_review_batch`'s refusals in order. None includes the recent authenticator check those
functions make at the time, or the row locks approval takes. pgTAP checks each against what the
functions actually do.

### Every field returned

**`list_review_batches`** → `{status: "ok" | "unknown_platform", items, next_after}`; each item:
`id`, `status`, `created_at`, `decided_at`, `platform {slug, name, short_name}`,
`source {provider, provider_name, name, fetched_at}`, `creator {handle, you}` (null if the account
is gone), `items`, `flagged`, `sampled` (the sample size), `required`, `recorded`, `pending`,
`critical_signals` (members with one), `critical_errors` (members with one recorded),
`approvals {recorded, required}`.

**`get_review_batch_overview`** → null for an unknown batch, else: `id`, `status`, `reason`,
`created_at`, `decided_at`, `decision_reason`, `creator`, `platform`, `source {run_id, provider,
provider_name, name, snapshot_sha256, fetched_at, finished_at, terms_sha256}`, `content_sha256`,
`seed`, `sampling {sample_size, acceptance_number, tolerable_error, confidence}`, `counts {items,
critical, flagged, sampled, unsampled, with_info_flags, required, pending, recorded, correct,
incorrect, excluded, critical_errors, sample_errors}`, `approvals {required, recorded, by: [{person,
at}]}`, `blockers [{code, count}]`, `ready`, `you {review, approve}`.

**`list_review_batch_members`** → null for an unknown batch, else `{batch {id, status}, filter,
items, next_after}`; each item: `game {id, title, status}`, `pairing_status`, `category`,
`sampled`, `flags`, `info_flags`, `critical_flags`, `source {provider, external_id}`,
`requires_outcome`, `outcome`, `critical_error`, `note`, `recorded_at`, `reviewer`, `stale` (null
unless the batch is open).

**`get_review_batch_member`** → null unless the game is a member, else: `batch {id, status,
content_sha256, created_at, platform, approvals}`; `member {category, sampled, flags, info_flags,
critical_flags, requires_outcome, frozen_game_revision, outcome, critical_error, note, recorded_at,
reviewer, stale}`; `game {id, title, kind, status, revision, slug, first_release {value,
precision}, identity_verified}`; `pairing {status, physical_confirmed, releases {total, published}}`;
`source {provider, provider_name, external_id, payload_sha256, snapshot_sha256, record, assessment
{assessor, assessor_version, problems}}`; `conflicts {same_title [{id, title, status, on_platform,
in_batch}], shared_ids [{id, title}], linked_elsewhere [{id, title, status}]}` (20, 20 and 10 at
most); `batches` (this game's batches on the platform, newest first, 20 at most: `id, status,
created_at, decided_at, sampled, flagged, outcome, critical_error, recorded_at`); `trail` (its
outcomes in this batch, oldest first, 10 at most: `at, person, outcome, critical_error, note`);
`you {record, options, keep_critical_error}`.

**`source.record`** (allow-listed; anything of another shape is left out): `title` (300
characters), `titles` and `ja_titles` (20 strings of up to 300, no control characters),
`first_release {value, precision}` (a date of 4, 7 or 10 characters), `revision` (a positive
integer), `platform_first_release {value, precision}`, `distribution_formats` and `instance_of`
(20 Wikidata item ids), `platforms` (a count only), `external_ids {igdb, mobygames}` (10 ids each,
letters, digits, `.`, `_` and `-`), `detail` (whether the full entity was staged). The raw payload
(developers, publishers, genres, labels and anything else) is never returned.

**People** appear by handle only, or "you"; never an email address or an account id. **Links** to
the source are built in the app only from a Wikidata item id (`Q` and digits) and a positive
revision number, and open in a new tab with `rel="noopener noreferrer nofollow"`. Provider text is
always rendered as text, never as markup.

## Tests

- **pgTAP** `55_m14c2_review_batch_reads` (115 assertions): visitors, collectors, editors without
  a verified factor, a removed editor and the service role are refused; the helpers are owner only;
  all four are STABLE; the list's order, pages (one at a time, every batch once), status and
  platform filters, an unknown platform, bounds and cursors; a listed batch's counts, source and
  creator, and no email address or account id; the overview's counts, categories, provenance,
  sampling, blockers and `you`, each blocker checked against `approve_review_batch` in that state
  (pending, sample failed by an incorrect and by an excluded sampled member, critical error
  unresolved, evidence missing, stale, rights withdrawn, own member); members' order, fields,
  filters and their counts, pages of three, a member reviewed while paging (none skipped), notes
  and reviewers, staleness, bounds and cursors; a member's fields, pairing and source; `you.record`
  for each reason, checked against `record_batch_outcome`; the options after an incorrect finding;
  the trail; the batch history; the allow-listed source fields against a hostile payload; possible
  duplicates and conflicts; and that the review rules are unchanged. Tests 03 and 10 list the new
  functions. Baseline: 55 files, 4,326 assertions.
- **Unit** `npm run batches:test`: the copied flag reasons, critical errors and formats equal the
  importer's; the evidence rule matches `private.evidence_note_ok`'s edge cases; source links;
  reading the form; filters; fixed messages; blocker wording.
- **App** `app:review-batch-checks` (scratch only; 116 checks): the empty list; the list, filters
  and pages; a batch's provenance, sampling, blockers and member pages; no form that acts on a
  batch; critical, flagged, sampled and unsampled members; the three kinds of evidence; escaped,
  allow-listed source text and safe links; recording without JavaScript (incorrect with a critical
  error, then excluded), a resubmitted stale form, a short note, a missing confirmation, two
  submissions at once, a page read before the game changed; a stale authenticator check and
  step-up; collectors, visitors and direct API calls; in a real browser, recording with the
  keyboard only, the announced error and status messages, the exact note kept; axe (WCAG 2.2 AA)
  and no sideways scrolling at phone and desktop widths on eight page states. `app:a11y-checks` also
  audits the batch list where the migration is present.

## Left for M14c-3

Done in M14c-3 ([catalog-publishing-m14c3.md](catalog-publishing-m14c3.md)): approving and rejecting batches in
the UI, independent publication and its queue, and the CLI `publish` step. The real pilot's
prerequisites are listed there.
