# Architecture decisions

**Status:** Approved design, including the decisions on D1 to D9, Q1 to Q12, A1 to A3, P1 to P10, R1 to R8 and D13, and the strict physical-only scope. M0 to M8 are implemented and merged; none has run on a hosted project yet. M9, internationalization, is cancelled: the application is English-only ([M10 decisions](#m10-decisions-the-admin-panel-expansion), D1). M10, the admin panel expansion, is built in five steps, M10a to M10e, with the M10 integration review's corrections ([ADR-062](#adr-062-the-m10-integration-review-retires-the-raw-admin-reads-and-withholds-staff-reasons-from-moderators)); it waits for the product owner's approval of the pull request. Each step needs the product owner's authorization.

This records why the database is designed as it is, what each choice costs, and what still needs a product decision. [Product-owner decisions](#decisions-requiring-product-owner-approval) are listed first because some still block implementation.

## Summary

| ADR | Decision |
| --- | --- |
| [001](#adr-001-game-release-and-collection-item-are-separate) | Game, Release and Collection Item are separate tables |
| [002](#adr-002-region-codes-and-markets-are-independent) | Region codes and markets are independent |
| [003](#adr-003-private-purchase-data-lives-in-its-own-table) | Private purchase data lives in its own table |
| [004](#adr-004-visibility-is-layered-and-the-most-restrictive-wins) | Visibility is layered, and the most restrictive setting wins |
| [005](#adr-005-followers-only-means-accepted-followers) | Followers-only means accepted followers |
| [006](#adr-006-grants-and-rls-work-together) | Grants and RLS work together |
| [007](#adr-007-uuid-strategy) | UUIDs, with UUIDv7 for high-volume tables |
| [008](#adr-008-composite-foreign-keys-enforce-ownership) | Composite foreign keys enforce ownership |
| [009](#adr-009-exclusive-arcs-instead-of-polymorphic-references) | Exclusive arcs instead of polymorphic references |
| [010](#adr-010-reviews-extend-posts) | Reviews extend posts |
| [011](#adr-011-a-few-trigger-maintained-counters) | A few trigger-maintained counters |
| [012](#adr-012-fractional-ranks-for-ordering) | Fractional ranks for ordering |
| [013](#adr-013-soft-delete-only-where-evidence-matters) | Soft delete only where evidence matters |
| [014](#adr-014-enums-for-closed-sets-tables-for-open-ones) | Enums for closed sets, tables for open ones |
| [015](#adr-015-metadata-providers-are-replaceable-adapters) | Metadata providers are replaceable adapters |
| [016](#adr-016-catalog-changes-are-reviewed-and-merges-leave-tombstones) | Catalog changes are reviewed, and merges leave tombstones |
| [017](#adr-017-every-image-records-its-source-and-license) | Every image records its source and license |
| [018](#adr-018-feeds-read-on-demand-first) | Feeds read on demand first |
| [019](#adr-019-search-starts-in-postgresql) | Search starts in PostgreSQL |
| [020](#adr-020-staff-see-messages-only-through-reports) | Staff see messages only through reports |
| [021](#adr-021-achievements-are-awarded-by-the-server) | Achievements are awarded by the server |
| [022](#adr-022-partition-later-not-now) | Partition later, not now |
| [023](#adr-023-private-by-default-with-an-explicit-publish-step) | Private by default, with an explicit publish step |
| [024](#adr-024-indexing-is-a-profile-preference) | Indexing is a profile preference |
| [025](#adr-025-the-product-is-permanently-physical-only) | The product is permanently physical-only |
| [026](#adr-026-game-classification-is-a-manual-decision-recorded-as-relationships) | Game classification is a manual decision, recorded as relationships |
| [027](#adr-027-frankfurt-is-the-proposed-initial-region) | Frankfurt is the proposed initial region |
| [028](#adr-028-release-eligibility-and-playability-are-separate) | Release eligibility and playability are separate |
| [029](#adr-029-invalid-records-are-preserved-not-deleted) | Invalid records are preserved, not deleted |
| [030](#adr-030-a-collection-item-always-includes-the-game-medium) | A Collection Item always includes the game medium |
| [031](#adr-031-platform-identity-is-separate-from-its-names) | Platform identity is separate from its names |
| [032](#adr-032-physical-media-is-a-category-plus-a-reference-format) | Physical media is a category plus a reference format |
| [033](#adr-033-hardware-requirements-sit-on-the-release) | Hardware requirements sit on the Release |
| [034](#adr-034-multiple-media-reuses-the-release-component-model) | Multiple media reuses the Release component model |
| [035](#adr-035-game-boy-classification-follows-the-physical-edition) | Game Boy classification follows the physical edition |
| [036](#adr-036-the-public-profile-card-is-enforced-with-column-grants) | The public profile card is enforced with column grants |
| [037](#adr-037-handles-are-unique-by-spelling-and-normalized-only-against-reserved-names) | Handles are unique by spelling, and normalized only against reserved names |
| [038](#adr-038-avatars-are-written-only-by-the-server) | Avatars are written only by the server |
| [039](#adr-039-account-activation-needs-a-verified-email-and-a-handle) | Account activation needs a verified email and a handle |
| [040](#adr-040-follows-and-blocks-are-reached-only-through-functions) | Follows and blocks are reached only through functions |
| [041](#adr-041-rejection-is-silent) | Rejection is silent |
| [042](#adr-042-follower-counts-are-live-and-count-visible-relationships) | Follower counts are live, and count visible relationships |
| [043](#adr-043-the-audit-log-is-private-and-append-only-for-application-roles) | The audit log is private, and append-only for application roles |
| [044](#adr-044-notifications-come-from-state-changes-in-the-same-transaction) | Notifications come from state changes, in the same transaction |
| [045](#adr-045-catalog-records-are-verified-before-they-are-published) | Catalog records are verified before they are published |
| [046](#adr-046-imports-run-as-a-restricted-role-through-audited-functions) | Imports run as a restricted role through audited functions |
| [047](#adr-047-catalog-search-reads-published-records-through-read-only-functions) | Catalog search reads published records through read-only functions |
| [048](#adr-048-web-sessions-are-handled-only-on-the-server) | Web sessions are handled only on the server |
| [049](#adr-049-collections-are-owner-only-copies-added-idempotently) | Collections are owner-only copies, added idempotently |
| [050](#adr-050-catalog-submissions-write-the-catalogs-own-records-privately) | Catalog submissions write the catalog's own records, privately |
| [051](#adr-051-catalog-review-goes-through-audited-functions-and-nothing-is-published-without-it) | Catalog review goes through audited functions, and nothing is published without it |
| [052](#adr-052-copies-keep-their-piece-records-are-checked-against-their-release-under-a-lock-and-are-moved-only-by-their-owner) | Copies keep their piece records, are checked against their release under a lock, and are moved only by their owner |
| [053](#adr-053-exclusion-preserves-every-copy-cascades-only-what-the-publication-rules-need-and-is-restored-by-another-administrator) | Exclusion preserves every copy, cascades only what the publication rules need, and is restored by another administrator |
| [054](#adr-054-merging-moves-every-copy-with-everything-recorded-never-changes-the-target-and-keeps-unpublished-merges-private) | Merging moves every copy with everything recorded, never changes the target, and keeps unpublished merges private |
| [055](#adr-055-the-owner-is-a-protected-record-its-authority-needs-mature-mfa-and-recovery-is-an-audited-operator-procedure) | The Owner is a protected record, its authority needs mature MFA, and recovery is an audited operator procedure |
| [056](#adr-056-dark-mode-is-the-only-supported-appearance-for-the-initial-release) | Dark Mode is the only supported appearance for the initial release |
| [057](#adr-057-the-admin-overview-shows-role-scoped-bounded-counts-decided-in-the-database) | The admin overview shows role-scoped, bounded counts, decided in the database |
| [058](#adr-058-catalog-history-is-an-allow-listed-view-of-the-audit-log) | Catalog history is an allow-listed view of the audit log |
| [059](#adr-059-a-records-creator-is-kept-privately-and-never-reviews-it) | A record's creator is kept privately, and never reviews it |
| [060](#adr-060-imports-and-the-system-are-read-only-views-for-administrators-and-reference-data-is-the-public-tables) | Imports and the system are read-only views for administrators, and reference data is the public tables |
| [061](#adr-061-accounts-audit-and-staff-are-allow-listed-reads-over-the-m8-functions) | Accounts, audit and staff are allow-listed reads over the M8 functions |
| [062](#adr-062-the-m10-integration-review-retires-the-raw-admin-reads-and-withholds-staff-reasons-from-moderators) | The M10 integration review retires the raw admin reads and withholds staff reasons from moderators |
| [063](#adr-063-invitations-are-supabase-native-sent-with-a-server-only-secret-key-after-the-database-authorizes) | Invitations are Supabase-native, sent with a server-only secret key after the database authorizes |

## Decisions requiring product-owner approval

### What still blocks migrations

**Only the product owner's authorization of each step.** The [plan](#phase-2b-plan) is the accepted roadmap. M0 to M8 are implemented and merged, and M10 is in progress.

### D1 to D9: product owner's decisions

| # | Decision | Status | Outcome |
| --- | --- | --- | --- |
| **D1** | Followers only | **Approved** | Access requires an accepted follow |
| **D2** | Default privacy | **Approved with change** | Collections, shelves and items default to **private**. Users explicitly choose to publish. Purchase information stays owner-only. See [ADR-023](#adr-023-private-by-default-with-an-explicit-publish-step) |
| **D3** | Signed-out browsing | **Approved** | Public profiles, collections, games and posts are browsable without signing in. Private information is never exposed. Indexing preferences are supported. See [ADR-024](#adr-024-indexing-is-a-profile-preference) |
| **D4** | Consoles and accessories | **Approved** | Physical video games only, with no console or accessory catalog. Further defined by [ADR-025](#adr-025-the-product-is-permanently-physical-only) |
| **D5** | User-submitted releases | **Approved with change** | Submissions are marked unverified and usable immediately by the submitter. They never automatically become global entries. Staff moderate them through a workflow. See [ADR-016](#adr-016-catalog-changes-are-reviewed-and-merges-leave-tombstones) |
| **D6** | Game versus Release | **Approved** | Ports share a Game. Remakes are separate Games. Different editions, regions and packaging variants are separate Releases. Further defined by [ADR-026](#adr-026-game-classification-is-a-manual-decision-recorded-as-relationships) |
| **D7** | Region taxonomy | **Approved** | A flat [taxonomy](database-schema.md#region_codes) of 11 codes, plus independent distribution markets and physical edition identity, replaces the earlier hierarchy. See the [examples](relationships.md#physical-release-examples) and [ADR-002](#adr-002-region-codes-and-markets-are-independent) |
| **D8** | Rating scale | **Approved** | Half-point steps from 0.5 to 10 |
| **D9** | Review eligibility | **Approved** | Any active user may review. Ownership is self-reported and not required. Only published games and releases can be reviewed |
| **D13** | Data region | **Selected as proposed** | Central EU (Frankfurt), AWS `eu-central-1`. Project not created. Legal review outstanding. See [ADR-027](#adr-027-frankfurt-is-the-proposed-initial-region) |

### Q1 to Q7: product owner's decisions

| # | Question | Decision |
| --- | --- | --- |
| **Q1** | Region tree | **Replaced** by the region code and market model in D7 |
| **Q2** | Remasters | **Decided.** See [ADR-026](#adr-026-game-classification-is-a-manual-decision-recorded-as-relationships) |
| **Q3** | Indexing default | **Off.** Users opt in. It doesn't affect access control |
| **Q4** | Wantlist privacy | **Private by default.** Users can make them public |
| **Q5** | Post visibility | **Composer may preselect public.** Visibility is explicit and changeable, the database never silently makes an unspecified post public, and RLS enforces the selection |
| **Q6** | Boxed download codes | **Excluded**, along with all other digital products. See [ADR-025](#adr-025-the-product-is-permanently-physical-only) |
| **Q7** | Public items on unverified releases | **Approved.** A neutral "Unverified release" placeholder, exposing none of the submitted text |

### Q8 to Q12: product owner's decisions

| # | Question | Decision |
| --- | --- | --- |
| **Q8** | Partial media | **Conditionally allowed.** The medium must contain actual game data, and `media_playability` records whether additional downloads are needed. Unclear eligibility requires editor review. See [ADR-028](#adr-028-release-eligibility-and-playability-are-separate) |
| **Q9** | Invalid or out-of-scope releases | **Preserve user data.** Excluded from the catalog, with no new additions, owners notified, records kept private and uncounted, and a controlled resolution process. See [ADR-029](#adr-029-invalid-records-are-preserved-not-deleted) |
| **Q10** | Arcade boards | **Excluded from launch scope.** No arcade boards, hardware or accessory catalog |
| **Q11** | Region-free platforms | **Approved.** Classify by collector-facing regional identity. `region-free` only for a release genuinely classified that way |
| **Q12** | Box-only and manual-only items | **Excluded, final.** The medium must be present. See [ADR-030](#adr-030-a-collection-item-always-includes-the-game-medium) |

### A1 to A3: product owner's decisions

| # | Question | Decision |
| --- | --- | --- |
| **A1** | Collection statistics | **Approved.** Only active Collection Items on approved, qualifying physical Releases count as owned. Unverified submissions show separately as pending. Rejected, excluded and invalid-preserved records are distinguishable from pending, and never count |
| **A2** | Preserved records | **Approved.** No automatic deletion by age. Owners may delete their own. A formal retention policy will be defined before real user data is processed |
| **A3** | Meaningful game data | **Approved.** Written editorial eligibility guidelines are required before catalog approval workflows open. The medium must contain actual game data. Download codes, Game-Key Cards, installer-only and launcher-only media and digital entitlements stay excluded. Unclear cases require editorial review |

### P1 to P10 and R1 to R8: product owner's decisions

| # | Decision | Outcome |
| --- | --- | --- |
| **P1** | Regional names | **Approved.** One canonical platform, with hardware and media differences preserved at the Release level |
| **P2** | Platform identity | **Approved.** Stable slugs, with names stored separately |
| **P3** | Hardware revisions | **Approved with change.** No automatic new platforms, with release-level requirements. See [ADR-033](#adr-033-hardware-requirements-sit-on-the-release) |
| **P4** | Add-ons | **Approved.** Separate software platforms, using `base_platform_id`. No collecting of hardware |
| **P5** | Cross-compatible products | **Approved.** One Release on its primary intended platform, with ambiguous cases going to editors |
| **P6** | Home computers and PC | **Permanently in scope**, in a later seed batch. Digital-only software, download-code boxes and installer-only products stay excluded |
| **P7** | Media formats | **Modified.** Category plus specific format. See [ADR-032](#adr-032-physical-media-is-a-category-plus-a-reference-format) |
| **P8** | Schema | **Approved.** `platform_names` and `base_platform_id` added. `generation` removed. The array was replaced by a table |
| **P9** | Evercade | **In scope**, in a later seed batch, because its games are on the cartridge |
| **P10** | Platform seed | **Accepted** after checks, with uncertain values null |
| **R1** | Hardware requirements | **Approved** |
| **R2** | Media reference model | **Approved**, through a forward migration |
| **R3** | Manufacturer | **Approved.** The platform owner or primary brand |
| **R4** | Proprietary media names | **Approved.** Specific names |
| **R5** | Aliases | **Approved.** Official regional names and common aliases, excluding clones, codenames and unrelated hardware models |
| **R6** | Multiple media | **Modified.** One Release can hold several pieces and formats. See [ADR-034](#adr-034-multiple-media-reuses-the-release-component-model) |
| **R7** | Game Boy classification | **Modified.** Three distinct cases. See [ADR-035](#adr-035-game-boy-classification-follows-the-physical-edition) |
| **R8** | Seed sources | **Conditionally approved.** Recorded in [reference-data-sources.md](reference-data-sources.md) |

### M4-D1 to M4-D12: product owner's decisions for M4

These are separate from D1 to D22 above. M4 documents cite them as M4-D1 to M4-D12.

| # | Decision | Outcome |
| --- | --- | --- |
| **M4-D1** | Audit log | **Approved.** `private.audit_events`, append-only for application and API roles. Replaces the planned `moderation_actions`. See [ADR-043](#adr-043-the-audit-log-is-private-and-append-only-for-application-roles) |
| **M4-D2** | Who reads the audit log | **Approved.** Admins only, through `get_audit_events()`; since the M10 integration review, through `get_audit_log()` ([ADR-062](#adr-062-the-m10-integration-review-retires-the-raw-admin-reads-and-withholds-staff-reasons-from-moderators)) |
| **M4-D3** | Duplicate notifications | **Approved.** One notice per event, and repeated follows of one account notify once per 24 hours |
| **M4-D4** | Deleted accounts in notifications | **Approved.** Deleting the recipient or the actor deletes the notice |
| **M4-D5** | Who suspends | **Approved.** Moderators suspend and reinstate accounts without a staff role. Admins handle staff accounts. Nobody suspends themselves |
| **M4-D6** | Suspended users | **Approved.** They can still cancel, unfollow, reject, remove followers, block and unblock, as in M3 |
| **M4-D7** | Auth-level bans | **Deferred.** Suspension does not invalidate existing Auth sessions or prevent sign-in. Protected operations enforce account status at the database level, while explicitly permitted access-reducing operations, such as unfollowing and blocking, remain available |
| **M4-D8** | Moderation notices | **Approved.** Mandatory, and never include the staff member or their reason |
| **M4-D9** | Notification preferences | **Approved.** In-app only, on by default, with no backfill when turned on |
| **M4-D10** | Retention of notifications and audit events | **Undecided,** pending legal review and [D10](#needed-before-launch-may-need-legal-advice). M4 has no purge or scheduled deletion |
| **M4-D11** | Notification access | **Approved.** Only through `SECURITY DEFINER` functions. No API role has table access. See [ADR-044](#adr-044-notifications-come-from-state-changes-in-the-same-transaction) |
| **M4-D12** | Granting `admin` | **Superseded in M8** by D4: only the Owner grants or revokes `admin`. Originally: one active admin may grant `admin`, and the grant is audited |

### M5 decisions: the catalog and its import

Approved by the product owner on 2026-11-08, separate from the global decisions above.

| Decision | Outcome |
| --- | --- |
| Product status | Treated as potentially commercial |
| Sources | Wikidata and No-Intro for a limited SNES pilot, subject to each source's licensing check. Metadata permission never covers artwork or third-party content. Redump blocked until written commercial permission, and PS1 and PS2 support doesn't depend on it |
| Neo Geo MVS | A separate platform, `platform_kind = 'other'`, with its own `neo-geo-mvs-cartridge` format. Cartridges only, never cabinets or boards. AES and MVS cartridges are physically different and incompatible |
| Scope of candidates | Legitimate homebrew, aftermarket, unlicensed, demo and promotional releases are review candidates. Counterfeit and pirate copies are rejected |
| Identity | Matching serials are evidence, never grounds to merge. ROM revisions aren't separate releases unless a distinct physical product is confirmed. Game candidates without a Wikidata id are allowed, under review |
| Imports | A local operator tool. Source snapshots stay outside the repository, with provenance and hashes. Nothing is published automatically |
| Batch approval | Allowed for game records. Releases only when every release's identity and required fields have independent source evidence |
| Verification | Separate from publication, and required for it. Publishing a release also publishes its verified game and pairing (decisions 1 and 5) |
| Defaults | None invented: an edition is required to publish, and an `unknown` region needs explicit confirmation (decision 2) |
| Editors | Active catalog editors and administrators. One editor may verify and publish (decision 3). Shared staff lock. A reason for every change, including to verify and publish |
| Lifecycle | Slugs freeze on publication. No unpublishing in M5 |
| Search | Language-neutral PostgreSQL search, with 100 ms as a non-blocking local target (M5c) |
| Images | Deferred until D15 |

### M8 decisions: the Superadmin Foundation

Approved by the product owner on 2026-11-14, separate from the global decisions above. M8 migrations, tests and [security-rls.md](security-rls.md#the-owner-m8) cite them as D1 to D19, and the addendum's sections as A1 to A5. "Built" describes what was implemented, where it differs from the proposal.

| # | Decision | Outcome |
| --- | --- | --- |
| **D1** | The Owner | **Approved.** A singleton `private.platform_owner` record, not a `staff_role` value. Identity (`is_designated_owner`) is separate from eligibility (`owner_authority_refusal`), and every protection uses identity only (A1) |
| **D2** | Assigning the Owner | **Approved.** An operator procedure, `private.assign_initial_owner`, needing good standing and two verified factors. No endpoint, no automatic or hidden Owner |
| **D3** | MFA | **Approved.** A live verified session for every staff privilege, and a TOTP verification in the last 10 minutes for sensitive actions, with 60 seconds of clock skew. **Built:** also required for published merges (M8d) |
| **D4** | Administrator grants | **Approved.** Only the Owner, with Owner authority, grants or revokes `admin`. Supersedes M4-D12 |
| **D5** | Ownership transfer | **Approved.** Two steps, expiring after 72 hours. The previous Owner stays an administrator |
| **D6** | Recovery | **Approved.** A factor reset or a reassignment, opened and completed by an operator after a 72-hour hold, with Owner authority frozen and the target confirming in the app |
| **D6a** | Succession document | **Approved.** Its SHA-256 fingerprint is registered by the Owner with fresh MFA. The document stays outside the database with two custodians, and is checked with independent approvals during a reassignment |
| **D6b** | Cancelling a recovery | **Approved with safeguards.** The designated Owner may cancel with a live session, fresh MFA and one factor. **Built:** after such a cancellation, an operator may open a disputed recovery within 30 days, which only an operator can cancel |
| **D6c** | The previous Owner's role after a reassignment | **Approved.** Removed in the same transaction. Not for a voluntary transfer |
| **D7** | Changing one's own roles | **Approved.** Nobody can (`self_change`) |
| **D8** | Unauthorized `/admin` | **Approved.** `notFound()` |
| **D9** | Refused attempts | **Approved.** Returned as `{"ok": false, "refusal", "audit_id"}` and committed with their audit row only, rate-limited. Trigger refusals leave a server log line |
| **D10** | Catalog review pages | **Approved.** Moved to `/admin/catalog/*`, with permanent redirects from `/review/*` |
| **D11** | Account lookup | **Approved.** By exact handle only |
| **D12** | Deleting the Owner | **Approved.** A foreign key, delete and truncate triggers, the server's pre-check and `owner_integrity()`, all keyed on identity |
| **D13** | Factors for Owner authority | **Approved.** At least two verified TOTP factors, each mature 24 hours after it's first verified. **Built:** maturity is measured from our own registration ledger, because Auth's `created_at` is the enrollment time (preflight finding B2) |
| **D14** | Successor | **Approved.** A visible designation that gives no privilege |
| **D15** | Staff function results | **Approved.** `jsonb`, migrated with a guard block and exact-signature drops, without `CASCADE` |
| **D16** | Auth dependency | **Approved.** Read-only access to `auth.sessions`, `auth.mfa_factors` and `auth.mfa_amr_claims`, guarded so a changed schema fails closed, with a contract test |
| **D17** | Timings | **Approved.** A 72-hour recovery hold and a 72-hour transfer expiry |
| **D18** | Hosted prerequisites | **Approved as launch blockers,** not M8 work: hosted TOTP, `pgaudit`, key custodians and alerts. See [Production launch prerequisites](security-rls.md#production-launch-prerequisites-m8) |
| **D19** | Local TOTP | **Approved.** Enabled in `supabase/config.toml` for the local stack |

### M10 decisions: the admin panel expansion

Approved by the product owner on 2026-11-16, with the M10 plan. M10 is built in five steps, each authorized and reviewed on its own: M10a foundations and dashboard, M10b catalog search and record pages, M10c catalog editing, M10d reference data, imports and system, and M10e accounts, audit and staff. Every M8 guarantee stays in force.

| # | Decision | Outcome |
| --- | --- | --- |
| **D1** | Internationalization | **Approved.** The planned M9 (English and Serbian) is cancelled for good. My Game Dex is an English-only international application, with no translations and no language switcher. |
| **D2** | Staff-created records | **Approved.** A staff member must not verify or publish a game or release they created, so direct creation keeps the same no-self-review rule as member submissions. Before `submitted_by` changes, M10c reviews its whole lifecycle (publication, audit provenance, merges, tests) and proposes how the creator stays recorded until an independent review. **Done in M10c** with a private provenance record, leaving `submitted_by` as it was ([ADR-059](#adr-059-a-records-creator-is-kept-privately-and-never-reviews-it)). |
| **D3** | Fresh MFA for sensitive catalog work | **Approved.** Verifying, publishing and protected edits to published records need a TOTP verification in the last 10 minutes, checked in the database, so direct API calls are held to it too (M10c). **Done in M10c,** with excluding and restoring published releases too ([ADR-059](#adr-059-a-records-creator-is-kept-privately-and-never-reviews-it)). |
| **D4** | Catalog history for editors | **Approved.** Catalog editors may read a sanitized, bounded history of the catalog records they may work on. It shows no staff-account events, private account information, emails, purchase data or unrelated audit rows (M10b). **Done in M10b** ([ADR-058](#adr-058-catalog-history-is-an-allow-listed-view-of-the-audit-log)). |
| **D5** | Reference data | **Approved.** Platforms, markets, regions and formats stay managed by migrations, and read-only in M10. **Done in M10d:** read-only pages for catalog editors, from the public tables ([ADR-060](#adr-060-imports-and-the-system-are-read-only-views-for-administrators-and-reference-data-is-the-public-tables)). |
| **D6** | Genres and franchises | **Approved.** Deferred to the Game Details milestone. The schema document marks them, and every other designed-but-unbuilt table, as planned. **Done in M10a.** |
| **D7** | System settings | **Approved.** A read-only view of the operational configuration. No editable settings or feature flags in M10 (M10d). **Done in M10d** ([ADR-060](#adr-060-imports-and-the-system-are-read-only-views-for-administrators-and-reference-data-is-the-public-tables)). |
| **D8** | Imports | **Approved.** Import runs and provider information are for administrators only. Scraping, provider integration and automated importing aren't authorized in M10. Monitoring imports is read-only; resolving a reclassification item is an audited write, through the existing `resolve_catalog_review`, and is described as one (M10d). **Done in M10d** ([ADR-060](#adr-060-imports-and-the-system-are-read-only-views-for-administrators-and-reference-data-is-the-public-tables)). |

### Needed before launch, may need legal advice

| # | Decision | Recommendation | Notes |
| --- | --- | --- | --- |
| **D10** | **Data retention on account deletion.** | Delete personal data and posts. Keep comments and messages with the author removed. Keep report snapshots for a defined period. Purge notifications after 90 days | **Needs legal review, and a formal retention policy before real user data is processed (A2).** GDPR's right to erasure may apply to retained content, especially message text and report snapshots |
| **D11** | **Message privacy.** | Protected by RLS and encryption at rest, without end-to-end encryption. Staff see only reported messages. Privacy policy states this plainly | End-to-end encryption is a large addition that limits moderation and search |
| **D12** | **Minimum age.** A global social network has to address COPPA, GDPR-K and similar rules. | Set a minimum age, such as 16, confirmed at sign-up, and store only the confirmation rather than a birth date | **Needs legal review.** Allowing younger users adds consent requirements |

### Needed before catalog work

| # | Decision | Recommendation | Notes |
| --- | --- | --- | --- |
| **D14** | **Metadata provider and budget.** | Contact IGDB and at least one alternative. No provider goes live until its terms are reviewed and `commercial_use_cleared` is set. See [ADR-015](#adr-015-metadata-providers-are-replaceable-adapters) | We couldn't confirm commercial terms from public sources. Treat all as unknown until confirmed in writing |
| **D15** | **Cover art.** Box art is typically owned by publishers, and a provider's API terms may not grant us display rights. Art is central to the product. | Get legal advice. Start with user-contributed photographs of owned copies, plus any art a provider explicitly licenses | **Needs legal review.** This could shape the visual product |
| **D16** | **Launch scope for messaging.** | One-to-one messaging only at launch, with the schema ready for groups | Groups add moderation and notification work |

## Decisions

### ADR-001: Game, Release and Collection Item are separate

**Decision.** Three separate tables, with `game_platforms` linking games and platforms. A release has a composite foreign key to `game_platforms`.

**Why.** They are different things. A user's favorite is a Game. A catalog entry with a product code is a Release. A copy with a crushed box corner and a price paid is a Collection Item. Merging any two breaks collector use cases: region variants couldn't be told apart, and a user couldn't own two copies.

**Trade-off.** Common screens need joins through three levels. This is fine with the indexes specified, and the reads can be cached at catalog level.

**Considered.** Dropping `game_platforms` and deriving it from `releases`. It was kept because it was part of the requested design, because the composite key catches bad data, and because it makes "games on this platform" a simple query. The earlier reason, that a game could be known on a platform before a physical release is cataloged, no longer applies: rows record physical availability only.

**Known limits.** Publishing a Game requires a qualifying physical Release, directly or through a compilation.

### ADR-002: Region codes and markets are independent

**Decision.** A release has one `region_code` from a controlled vocabulary of 11 values, and any number of `release_markets` rows naming actual countries or territories. There's no constraint between them, no hierarchy, and no table mapping a code to countries. Both attach to the platform-specific Release, never to the Game. Package identity stays on the Release as edition, variant, packaging, languages, rating labels, product code and barcode.

**Why.** A release's classification, where it was sold, and what the physical package is are three different facts. PAL, NTSC-U/C, NTSC-J and Asia don't map to fixed country lists, and conventions vary by platform and generation. Any fixed mapping would be wrong for some releases, and would push reviewers to invent data.

**Approved.** The product owner approved replacing the previously approved hierarchy with this flat taxonomy, since a hierarchy can't separate these three concepts: `pal-de` under `pal` assumes a country belongs to one code, and combines classification with market.

**A region code isn't a hardware lock.** Under Q11, a platform having no region lock doesn't make its releases `region-free`.

**How the requirements are met:**

| Requirement | How |
| --- | --- |
| Mexico isn't automatically separate | It's a market of a shared release when the physical edition is shared |
| Hong Kong, Taiwan and Southeast Asia aren't one release | `asia` is a classification only, and each package is its own Release |
| PAL stays broad | `pal` is one code, and countries are markets |
| Australia and New Zealand are representable without assuming identical packaging | They're markets, on a shared package or their own |
| Nothing is invented | `unknown`, and no market rows |
| Historical differences | Each classification belongs to one platform-specific Release, and withdrawn country codes can be added |

**Trade-offs.** Filtering is less automatic: "show me German releases" means filtering on market `DE`, and only finds releases whose markets are recorded. Catalog entry takes more effort. Markets may be incomplete, so absence isn't evidence. A mapping table could make entry faster later by suggesting values, but it must never enforce them.

### ADR-003: Private purchase data lives in its own table

**Decision.** Price, currency, purchase date, personal rating and notes go in `collection_item_private`, one-to-one with `collection_items`, readable only by the owner.

**Why.** RLS works on rows. Any policy that lets a visitor read a public item also exposes every column in it, including what the owner paid. Purchase history in a public response would be a serious privacy failure, and collectors are also an obvious theft target, so this data shouldn't be one mistaken query away.

**Alternatives considered.**

| Option | Problem |
| --- | --- |
| Single table, with a public view omitting the columns | The base table has to remain unreadable, and the view has to bypass RLS or re-implement it, so the safety depends on every future query |
| Single table with column grants | Owners need to read those columns while others don't, and grants apply per role, not per user |
| Encrypting the columns | Complicated, and blocks spending statistics |

**Trade-off.** Adding an item with purchase data writes two tables, handled by one database function. Owner views need a left join. Selectively sharing a price later would need a new mechanism, but loosening privacy later is much easier than recovering from a leak.

Personal rating is private by default for the same reason. Public opinions belong in `reviews`.

### ADR-004: Visibility is layered and the most restrictive wins

**Decision.** `profiles.collection_visibility` is a master switch. Each item and shelf also has its own `visibility`. A viewer needs to pass all of them, and shelves never grant access to items.

**Why.** Users need a one-click way to make everything private without touching every row. Keeping the settings independent means switching the master back restores the earlier per-item choices. All default to private under D2, as described in [ADR-023](#adr-023-private-by-default-with-an-explicit-publish-step).

**Trade-off.** Each row check calls a function. Queries are nearly always scoped to one owner, so this runs on a small set. Listing items across owners, such as "who owns this release", is the expensive case and should be precomputed.

### ADR-005: Followers-only means accepted followers

**Decision.** Approved as D1. `follows.status` has four states, set by controlled functions. See [ADR-041](#adr-041-rejection-is-silent). Only `accepted` grants access, and only while the follower's account is active.

**Why.** Without approval, followers-only offers no real protection. Adding `status` after launch would require a migration of a hot table, whereas including it now costs one column.

### ADR-006: Grants and RLS work together

**Decision.** Every table has RLS, explicit grants, and column-level update grants wherever a table has system or staff columns.

**Why.** RLS controls rows, not columns, so a user-update policy would otherwise allow forging `like_count`, `follower_count`, `account_status` or `moderation_status`. Default privileges are also set explicitly, because the local stack's defaults gave `anon` full access to new tables. See [security-rls.md](security-rls.md#explicit-grants).

**Consequence for staff.** Grants apply per role, and staff use the `authenticated` role. So staff can't write protected columns directly either. Their changes go through functions that check the staff role and record an audit row. This costs a function per staff action, and in return no staff change can skip the audit log.

**Trade-off.** A new column isn't client-writable until granted. That's a useful safe default, but can surprise developers, and insert grants need the same attention. CI checks guard against mistakes.

### ADR-007: UUID strategy

**Decision.** UUIDs throughout for user-generated and catalog entities. UUIDv7 for high-volume tables: `collection_items`, `posts`, `comments`, `likes`, `notifications`, `messages`, `reports`, `audit_events`, `provider_records`.

**Why.** UUIDs can be created anywhere and don't reveal totals in URLs. Random UUIDv4 values scatter inserts across the index, which hurts at large scale. UUIDv7 is time-ordered and so inserts near the end, and can double as the sort key for pagination.

**Trade-off.** UUIDv7 reveals its creation time. That's not a concern for these tables, where `created_at` is visible anyway, but it's a reason to avoid it on tables where creation time should stay private.

**Implementation.** The local Supabase stack runs PostgreSQL 17.11, which has no built-in `uuidv7()`, and the `pg_uuidv7` extension isn't available. M0 therefore adds `private.uuid_v7()`, which works on any version and can be replaced later without changing the schema. `gen_random_uuid()` remains the default for other tables.

**Ordering.** IDs from different milliseconds sort by time, and tests confirm it. Within one millisecond the order is random, so never assume strict monotonic ordering. Pagination needs a stable sort, and any feature needing an exact order must use another column too. `uuid_extract_timestamp()` doesn't decode version 7 on PostgreSQL 17, so nothing should rely on it.

### ADR-008: Composite foreign keys enforce ownership

**Decision.** Where a row links two things that must share an owner, it carries `owner_id` and uses composite foreign keys, such as `shelf_items` to `shelves` and `collection_items`. `posts` uses this for its item and shelf, and `reviews` uses `(release_id, game_id)` to keep a release consistent with its game.

**Why.** It makes cross-user links impossible at the database level, whatever the application or policy does.

**Trade-off.** A slightly redundant column and extra unique constraints. This is the one form of redundancy that adds safety rather than risk, because the foreign keys keep it consistent.

**Watch for.** PostgreSQL skips a composite foreign key when any of its columns is null. So `posts` needs `CHECK (release_id IS NULL OR game_id IS NOT NULL)`, and migrations must check this for every composite key with nullable columns.

### ADR-009: Exclusive arcs instead of polymorphic references

**Decision.** Tables pointing to one of several parents, such as `likes` and `reports`, have one nullable foreign key per parent, plus `CHECK (num_nonnulls(...) = 1)`.

**Why.** The common alternative of `target_type` and `target_id` can't have foreign keys, so it allows dangling references and has no cascading deletes.

**Trade-off.** Each new target type needs a new column. Targets are few and change rarely.

### ADR-010: Reviews extend posts

**Decision.** A review is a `post` with `kind = 'review'`, plus a `reviews` row holding the title, score and game. The text stays in `posts.body`.

**Why.** Reviews appear in the feed and need likes, comments, bookmarks, moderation and reports, all of which already work on posts. Storing the text once avoids it diverging.

**Trade-off.** Reviews and their posts must be written together, handled by one function. Game page queries join two tables.

### ADR-011: A few trigger-maintained counters

**Decision.** Only the counters listed in [the schema](database-schema.md#scale-and-performance) are stored. Others are computed or held in rollups.

**Why.** Counting likes for every post in a feed gets expensive, and these numbers appear everywhere.

**Trade-off.** Counters can drift and need a periodic reconciliation job. A viral post creates contention on one row. If that happens, move to batched updates. Counters aren't client-writable, because of the column grants.

### ADR-012: Fractional ranks for ordering

**Decision.** Shelves and shelf items sort by a text fractional index (`sort_rank`), compared with `COLLATE "C"`.

**Why.** Moving one game on a shelf with 2,000 items updates one row, rather than renumbering the rest. Users reorder often, and virtual shelves are core to the product.

**Trade-off.** Ranks grow if the same spot is repeatedly split, so an occasional rebalance is needed. Two concurrent moves can tie, so sorts break ties on the ID. `user_favorite_games` uses a simple `position`, as it's capped at 10.

### ADR-013: Soft delete only where evidence matters

**Decision.** `posts`, `comments`, `messages` and `reviews` have `deleted_at`. Everything else is a hard delete.

**Why.** Moderation needs to see what was said, even after deletion. Applying soft delete everywhere, though, leaves every query and unique constraint needing a filter, and it keeps personal data longer than necessary.

**Trade-off.** Soft-deleted content needs a purge schedule, which is part of [D10](#decisions-requiring-product-owner-approval).

### ADR-014: Enums for closed sets, tables for open ones

**Decision.** PostgreSQL enums for stable, closed sets used in code, such as `completeness` and `post_kind`. Lookup tables for sets with attributes or that staff should be able to change, such as `region_codes` and `markets`.

**Why.** Enums generate precise TypeScript types with `supabase gen types`, matching the discriminated unions Phase 1 already uses.

**Trade-off.** Enum values are easy to add, but hard to remove. Removing one needs a type swap migration, so values should be added carefully.

### ADR-015: Metadata providers are replaceable adapters

**Decision.** The internal database is the only source the application reads. Providers connect through server-side adapters, and their data enters through a staged, reviewable pipeline.

```mermaid
flowchart LR
  subgraph External
    A["Provider A"]
    B["Provider B"]
    C["Community sources"]
  end
  subgraph Adapters["Server-side adapters"]
    AA["Adapter A"]
    AB["Adapter B"]
    AC["Adapter C"]
  end
  A --> AA
  B --> AB
  C --> AC
  AA --> N["Normalized records"]
  AB --> N
  AC --> N
  N --> S[("private.provider_records")]
  S --> M{"Match to the catalog"}
  M -- "Matches a published record" --> P["Update, skipping locked fields"]
  M -- "New or uncertain" --> R["Staff review"]
  R --> P
  P --> DB[("games, releases, platforms")]
  DB --> App["Application"]
```

**Rules:**

1. **The application never calls a provider during a user request.** A provider outage or rate limit can't take down a page.
2. **Our IDs are ours.** Provider IDs live only in `external_references`, so several can link to one game and any can be dropped.
3. **Human corrections win.** `catalog_field_locks` stops a sync overwriting a corrected field.
4. **Nothing runs until cleared.** `commercial_use_cleared` and `images_cleared` on `external_providers` gate each provider, and the adapter's job checks them first.
5. **Images are copied only when licensed.** No hotlinking. See [ADR-017](#adr-017-every-image-records-its-source-and-license).
6. **A provider match never approves a user submission.** A match can suggest a merge to an editor, but can't change a submission's status, and new provider records also pass through staff review.
7. **Adapters import physical releases only.** Digital-only games and editions in a provider's data are ignored, and never promoted. Provider data alone doesn't establish that a product contains the game on a physical medium, so an editor still confirms it.

**The adapter contract.** Illustrative only, for the implementation phase:

```ts
type ProviderAdapter = {
  code: string;
  capabilities: { games: boolean; releases: boolean; platforms: boolean; images: boolean };
  listChangedSince(entity: CatalogEntity, since: Date, cursor?: string): Promise<ProviderPage>;
  fetchById(entity: CatalogEntity, externalId: string): Promise<ProviderRecord | null>;
  normalize(record: ProviderRecord): NormalizedRecord;
};
```

Each adapter is one module, for example `src/features/catalog/providers/<code>/`. Rate limits and retries sit in a shared job runner.

**What we found on providers.** Public information was thin, and none of this is legal confirmation:

| Provider | Finding | Status |
| --- | --- | --- |
| IGDB | Secondary sources say commercial use requires a partnership ([IGDB's post](https://medium.com/igdb/igdb-api-v4-is-coming-6ba97874edbc), [Twitch developer forum](https://discuss.dev.twitch.com/t/commercial-use-of-igdb-api/23567)) | Confirm directly |
| MobyGames | No commercial pricing or terms found | Unknown |
| ScreenScraper | No commercial terms found. Community tool documentation lists request limits ([Skyscraper docs](https://gemba.github.io/skyscraper/SCRAPINGMODULES)) | Unknown |
| TheGamesDB | No commercial terms found. Community tool documentation lists request limits (same source) | Unknown |

Most general game databases focus on games rather than physical releases. Expect region, edition and product code coverage to be uneven, which is one reason user submissions (D5) matter. Check each provider's coverage for releases as part of [D14](#needed-before-catalog-work).

**Trade-off.** More work upfront than calling an API directly, and there's a data delay. In return, there's no dependency on any provider and the catalog keeps its value independently.

### ADR-016: Catalog changes are reviewed, and merges leave tombstones

**Decision.** Approved under D5, with changes. User submissions are stored in `games`, `releases` and `game_platforms` with `status = 'unverified'`, and are visible only to the submitter and catalog editors. The submitter can attach their own items immediately. Only a staff function can publish one, and each submission has a record in `catalog_change_requests`. Duplicates are merged by setting `status = 'merged'` and `merged_into_id`, then moving references. The old row stays. The workflow is in [relationships.md](relationships.md#submission-and-approval-workflow).

**Why this storage.** `collection_items.release_id` stays a single required foreign key, so every collection query works the same way, and approval changes a status without moving the user's items. A separate submissions table would have needed an optional second reference on every collection item, and a migration of those references at approval.

**The risk of this choice** is that unverified rows sit beside real ones, so anything that bypasses RLS could expose them. Mitigations:

- Search indexes are partial on `published`.
- Jobs using the secret key, such as sitemaps, trending and provider matching, must filter on status, and tests check this.
- `game_platforms` has its own status, so a submission can't add a pairing to the public catalog.
- Global uniqueness applies to published rows only, so duplicate errors can't reveal another user's submission.
- `submitted_by` is cleared on approval, so a public row can't show who owns a rare release. A `CHECK` enforces this.
- Policies check `can_use_release()`, because foreign keys ignore RLS.

**Trade-off.** Needs admin tooling and staff time, and a backlog directly affects users, who see their release as unverified until reviewed. Several users may submit the same release, leaving editors to merge them. Repointing in large collections needs batches. A rejected record stays private to its submitter indefinitely, since the physical copy still exists.

**Excluded differs from rejected.** A rejected record is a genuine physical product with a problem, so the owner's copy and record stay as they are. An excluded record is outside the physical-only scope, so its attached items are preserved as invalid records. See [ADR-029](#adr-029-invalid-records-are-preserved-not-deleted).

**Tombstones.** Keep old links and provider references working, and `ON DELETE RESTRICT` protects user data from an accidental delete.

### ADR-017: Every image records its source and license

**Decision.** `catalog_images` stores `license_status`, `attribution` and `provider_code`. Only approved `licensed` and `user_contributed` images are readable by the public. All are stored in our own buckets, with submission images in a private bucket until approved, and `uploaded_by` cleared on approval. Posts and avatars are handled separately, as described in [security-rls.md](security-rls.md#storage).

**Why.** Rights vary by source, and art is central to this product. Recording the source lets us remove everything from one source if terms change. Hotlinking would make us dependent on another service and expose visitors' requests to it.

**Trade-off.** Storage cost and a review step. Until [D15](#needed-before-catalog-work) is settled, there may be limited cover art.

### ADR-018: Feeds read on demand first

**Decision.** The Following feed queries posts from followed users using `(author_id, id DESC)`. Latest uses a partial index on public posts. For You starts as a simple ranking on recent public posts.

**Why.** Pre-building a feed for each user is complex and only pays off at scale. On-demand reads handle the early stages and are simple to get right with RLS.

**Trade-off.** Following thousands of users, or very high traffic, will eventually be too slow. `feed_items` is the planned next step, adding a table without changing `posts`. Feed responses can't use shared caches because they're per-viewer.

### ADR-019: Search starts in PostgreSQL

**Decision.** Full-text search and trigram indexes in PostgreSQL for titles and handles. Search reads through the same database functions, so RLS still applies.

**Why.** It adds no new infrastructure and is sufficient for early Latin-script catalogs.

**Trade-off.** PostgreSQL's default text search and trigrams handle Japanese and other non-Latin scripts poorly, which matters for a global catalog with `local_title`. A dedicated search engine is the likely next step, fed by the catalog and restricted to public data.

### ADR-020: Staff see messages only through reports

**Decision.** No policy lets staff read conversations. Filing a report copies the reported message into `reports.content_snapshot`.

**Why.** It limits who can see private messages to the people in the conversation, and it's easy to explain to users. The secret key can technically read everything, so server code using it must be limited and audited.

**Trade-off.** Staff get less context when judging a report. Reporters could be allowed to include a few nearby messages, as a later refinement.

### ADR-021: Achievements are awarded by the server

**Decision.** `achievements` holds definitions and `user_achievements` holds awards, written only by server code. Clients can't insert a post with `kind = 'achievement'`.

**Why.** Achievement is a Phase 1 post type, but the requested table list had nowhere to store one, and letting users write their own would make them meaningless.

**Trade-off.** Two small extra tables. Note that achievements based on collection size, such as "Century Shelf", rest on self-reported data, so they can't be treated as proof of ownership.

### ADR-022: Partition later, not now

**Decision.** No partitioning at launch. High-volume tables use UUIDv7 and owner-scoped indexes to keep this path open.

**Why.** Partitioning adds real complexity, including restrictions on primary keys and foreign keys, and has no benefit at small scale.

**Trade-off.** Partitioning an existing large table is a real project. `collection_items` would need its primary key changed to include `owner_id`, which affects composite foreign keys. Revisit when any table nears roughly 100 million rows, or when maintenance becomes slow.

### ADR-023: Private by default, with an explicit publish step

**Decision.** Changed from the original recommendation under D2 and Q4. `profiles.collection_visibility`, `shelves.visibility`, `collection_items.visibility`, `wantlist_items.visibility` and their preferences all default to `private`. Purchase information remains owner-only regardless. Under Q5, `posts.visibility` has no database default, and the composer may preselect `public`.

**Why.** Users decide what becomes public, and a mistake leaves something hidden rather than exposed. Physical collections can be valuable, so this is the safer position.

**Trade-offs for the product owner:**

- **Thinner public content early on.** Trending, suggested collectors and public shelves depend on people choosing to publish. This works against the social-first goal, so onboarding should invite users to publish.
- **Several settings must agree.** A public shelf needs a public collection and public items. A user who makes only the shelf public would see an empty shelf from the outside. The design addresses this with an effective-visibility display and a single confirmed publish action, described in [security-rls.md](security-rls.md#making-things-public-under-private-defaults).
- **Posts can still disclose.** A public pickup post from a private item shows its release and completeness, by the author's explicit choice.

### ADR-024: Indexing is a profile preference

**Decision.** Approved under D3 and Q3. `profiles.allow_search_indexing` controls whether a user's public pages may be indexed, off by default. Published catalog pages are always indexable. Unverified records never are. It doesn't replace privacy or access control, and no policy reads it.

**Why on `profiles`.** A signed-out page needs to read it, and `user_preferences` is owner-only. It isn't sensitive.

**Trade-off.** Indexing rules are enforced by a `noindex` tag and sitemap omission, and search engines choose whether to honor them. So this reduces discovery and doesn't protect content. The default of off reduces search traffic.

### ADR-025: The product is permanently physical-only

**Decision.** My Game Dex exclusively catalogs, manages, showcases and discusses physical video game editions and physical collections. This is a permanent product requirement, not a launch limitation or a feature to revisit.

**The test.** A product qualifies only if its physical medium contains actual game data. Box, manual, inserts, maps and artwork are components of a physical edition, not products themselves, and a user must possess the physical game medium to add a game to their collection.

**Excluded permanently:** download codes in boxes, boxed digital download products, Game-Key Cards that only authorize downloading, digital-only editions, digital copies, account-bound entitlements, streaming and cloud gaming products, digital licenses and access keys, media containing only an installer, launcher or access key or no meaningful game data, and packaging or materials without the game.

**What this changes:**

| Area | Change |
| --- | --- |
| Media format | No boxed-code value exists, and `media_format_code` is required on every Release |
| `games` | Publishing requires a qualifying physical Release, directly or through a compilation |
| `game_platforms` | Records physical availability only, and the release date field was removed |
| `completeness` | `parts_only` is gone, and a Collection Item always includes the medium (Q12) |
| Catalog workflow | A new `excluded` state, separate from `rejected`, which preserves user records (Q9) |
| `media_playability` | Records whether a qualifying release needs additional downloads (Q8) |
| Provider adapters | Digital data is ignored and never promoted |
| Materials | `release_components` and `collection_item_components` record them as parts of an edition and a copy |

**Why no field records "contains game data".** Being published is the record of that decision: every published Release has been accepted by an editor as qualifying. A separate field would be self-reported and could disagree with the status. `media_playability` describes something different, covered in [ADR-028](#adr-028-release-eligibility-and-playability-are-separate).

**Trade-offs.** The database can't detect a Game-Key Card, because it's physically similar to a real game card, so correctness depends on editors, and they need a clear guideline. Modern platforms are where this is hardest. Some users will want to log products that are excluded, so the submission flow should explain the scope before they start.

### ADR-026: Game classification is a manual decision, recorded as relationships

**Decision.** A catalog editor decides whether something is a new Game, and records the link in `game_relations`. **Nothing is classified automatically, and marketing terminology alone never decides it.** A product called "Remastered", "HD" or "Definitive" may be either.

| Rule | Game record | Relationship |
| --- | --- | --- |
| Ports share a Game | Same | None |
| Straight technical enhancements, re-releases, reprints and simple redistributions | Same | None |
| Remakes | Separate | `remake_of` |
| Substantially rebuilt or materially altered remasters | **May be** separate, by editor decision | `remaster_of` |
| Collections containing multiple games | Separate, `kind = 'compilation'` | `contains`, for each game |
| Different physical editions, packaging, regions and print variants | Same | None. Separate Releases |

**Questions for editors**, in order:

1. Is this several games sold as one? If so, it's a compilation.
2. Was the game rebuilt, such as with new engine work or rebuilt assets, rather than running the original at a better resolution or frame rate?
3. Is the content or play materially altered, such as changed structure, mechanics or story?
4. If neither applies, it's the same Game. If the answer is unclear, keep it the same Game and record a note, because a merge is more work than a later split.

**Examples for consistency.** These apply the rules as guidance. Editors should confirm the facts of each case:

| Product | Treatment | Reason |
| --- | --- | --- |
| *Chrono Trigger* on PlayStation, after the SNES original | Same Game, new Release | A port |
| *Metal Gear Solid* Greatest Hits | Same Game, new Release | A reprint |
| *The Last of Us Remastered* | Same Game, new Release | A technical enhancement, despite the name |
| *Resident Evil* (2002, GameCube) | Separate Game, `remake_of` the 1996 original | A remake, despite the same title |
| *Metal Gear Solid: The Twin Snakes* | Separate Game, `remake_of` | A remake |
| *Shadow of the Colossus* (2018, PS4) | Separate Game, `remake_of` the PS2 game | Rebuilt |
| *The Legend of Zelda: Ocarina of Time 3D* | Separate Game, `remaster_of` | Substantially rebuilt. An example of a judgment call |
| *The Ico & Shadow of the Colossus Collection* | Separate compilation Game, `contains` both | The games inside stay the same Games |

**Trade-off.** Judgment means editors will sometimes disagree, so `game_relations.note` records the reasoning and `private.audit_events` records the decision. Reviews and favorites attach to the Game, so a split later would need those reassigned by hand.

### ADR-027: Frankfurt is the proposed initial region

**Decision.** D13 selects Central EU (Frankfurt), AWS `eu-central-1`, as the product owner's preference for the initial deployment. The project hasn't been created.

**Trade-offs.** Readers far from Europe will have higher latency for uncached data, which CDN caching of public content can reduce. A project's region is effectively fixed at creation, so changing later means a migration.

**Not a compliance claim.** Selecting an EU region isn't proof of GDPR compliance. The Data Processing Agreement, processing arrangements, backups and logs, storage and CDN behavior, international transfers, and applicable legal requirements all still need review, as listed in [security-rls.md](security-rls.md#data-region-and-legal-review).

### ADR-028: Release eligibility and playability are separate

**Decision.** Under Q8, whether a release qualifies is an editorial decision recorded by publishing it. Whether it plays without downloads is a fact on the release, `media_playability`: `playable_from_media`, `download_required` or `unknown`.

| Situation | Result |
| --- | --- |
| Playable from the medium, subject to normal installation | Published as `playable_from_media` |
| Holds actual game data, and downloads are needed for essential gameplay | Published as `download_required`, shown clearly |
| Holds actual game data, and download needs aren't known | Published as `unknown` |
| Eligibility is unclear | Stays in review. Never approved by default |
| Installer, launcher, access key, Game-Key Card, or no meaningful game data | Excluded |

**Why.** The two can differ: a disc can qualify and still need downloads. Having a disc or cartridge doesn't mean the complete game is available offline, so the default is `unknown`, never an assumption. A provider's data can't set it to `playable_from_media` on its own.

**Trade-offs.** Editors need evidence, and much of the catalog may stay `unknown`. Download requirements can change after release through patches, so this describes the medium as sold. Under A3, written editorial eligibility guidelines are required before catalog approval opens, because the database can't inspect a medium.

### ADR-029: Invalid records are preserved, not deleted

**Decision.** Under Q9, excluding a release never deletes user data. Attached items become `record_status = 'invalid_preserved'`, which makes them private and uncounted. The workflow is in [relationships.md](relationships.md#invalid-record-preservation-and-correction).

**Why a stored status rather than deriving it from the release.** It's a clear, indexable distinction between a valid game and a preserved record. Policies can check it on the row without a lookup per row, and it gives the resolution queue an index. Both are set in one transaction by the staff function. The trade-off is that the status and the release could disagree if a function were wrong, so tests check that they don't.

**Trade-offs.** Excluded releases can't be hard-deleted while records reference them, so they accumulate. Under A2, preserved records aren't deleted by age, so they stay until resolved, deleted by their owner, or covered by the retention policy still to be defined. A published release later excluded affects every owner, so exclusions need care, and reversal needs an admin. Owners of a preserved copy can read that excluded release, so it isn't hidden from everyone. That read is limited to owners, and is needed to correct the record.

### ADR-030: A Collection Item always includes the game medium

**Decision.** Under Q12, a Collection Item represents an actual physical game. No `completeness` value expresses a missing medium, `media_condition` can't be `not_included`, and a component can't exist without an item. A loose cartridge or disc is a valid item, and counts as one owned game. Sealed copies rely on the declared edition and sealed condition.

**Why completeness stays a declared value.** It isn't derived from `release_components`, because that data will often be incomplete, and a release's contents can't be checked against the copy. The completeness rules catch contradictions only.

**Trade-off.** Collectors can't log an empty box or a standalone manual, by design. The database prevents representing these, and can't verify what someone physically holds, so a false declaration can't be detected. Treat ownership as self-reported.

### ADR-031: Platform identity is separate from its names

**Decision.** A platform's identity is its slug, which a trigger makes immutable. Canonical names can change, and regional names and aliases live in `platform_names`. Mega Drive and Genesis, NES and Famicom, and PC Engine and TurboGrafx-16 are each one platform.

**Why.** Collectors treat these as one system with regional names, and duplicating them would split reviews, search and discussion.

**The rule that makes this safe.** A shared name doesn't imply compatibility: Famicom and NES cartridges have different pin counts, PC Engine and TurboGrafx-16 HuCards have reversed pins, and Japanese Mega Drive cartridges don't fit a Genesis. Those differences belong to each Release, and in `platforms.notes` for reference.

**`generation` was removed,** because console generations are disputed and nothing uses them. Adding it later is simple.

**Trade-off.** One platform row hides physical differences until Releases exist. Filtering by region must use the Release's region code, not the alias.

### ADR-032: Physical media is a category plus a reference format

**Decision.** A closed `media_category` enum holds the general type, and a `media_formats` table holds specific formats. `platform_media_formats` lists valid pairs, which M5 enforces with a composite foreign key. There's no `other` value: an unusual format gets a row, added by staff.

**Why a table, not an enum.** Physical formats are varied: HuCards, Videocarts, proprietary discs, and later cassettes and several floppy sizes. An enum would need a migration per format. A table also gives names and descriptions, and supports the foreign key. This replaces M0's unused `media_format` enum through a forward migration.

**Granularity rule.** A specific row exists only when collectors or manufacturers name that format. Otherwise the generic row plus the platform says enough. So most consoles share `rom-cartridge`, even though shells differ: the platform and Release record that.

**Physical-only.** A category can't express a digital product, and only staff can add a format, with a `CHECK` as a backstop. Game-Key Cards still rely on editors, because they look like game cards.

**Trade-off.** Editors will sometimes debate whether a format deserves its own row. Adding one later is simple.

### ADR-033: Hardware requirements sit on the Release

**Decision.** `hardware_requirements` holds definitions, and `release_hardware_requirements` links a Release to one at a level: `required`, `partial`, `not_compatible` or `compatible`. Revisions create no platform rows.

**Why not a single "requires" field.** Research found the real cases don't fit one: requiring a revision (New 3DS), failing on one (Virtua Racing on Genesis 3), and needing an add-on (Expansion Pak), sometimes only partly (Perfect Dark). Some differ by edition, which is why this sits on the Release.

**Why this isn't a hardware catalog.** Rows exist only when a release needs one, they have no ownership column, and nothing links them to collections. One row can describe a capability met in several ways, such as Super CD-ROM².

**Trade-offs.** Data will be incomplete at launch, so no row means nothing recorded, never "runs on everything". Soft limits, such as a game needing separate controllers on Switch Lite, aren't modeled until needed. Disc-less models such as Series S are a property of the hardware, so they need no rows.

### ADR-034: Multiple media reuses the Release component model

**Decision.** Approved as R6. `releases.media_format_code` is the primary format, and `media_count` counts its pieces. Additional formats in the same retail edition are `release_components` rows with `kind = 'game_media'`, a format and a platform. Separately sold formats remain separate Releases. No new table is needed.

**Alternatives considered.**

| Option | Why not |
| --- | --- |
| A `release_media` table listing every piece | Adds a table, and duplicates the primary format or makes every single-disc release need a child row |
| One Release per format in a box | Contradicts R6, and misrepresents one physical product |
| A format array on `releases` | Can't enforce valid platform and format pairs, or carry quantities |

**Validation.** A rolled-back prototype on the local PostgreSQL 17.11 confirmed multiple discs, multiple floppies, mixed formats, invalid format rejection, missing pieces on a copy, and that Q12 still holds. M5 adds real tests.

**Trade-offs.** Reading all media means reading two places. The "primary" format is an editorial judgment. Completeness stays declared, so a copy's pieces aren't checked against the edition automatically.

### ADR-035: Game Boy classification follows the physical edition

**Decision.** Approved as R7. Original Game Boy, dual-mode and Game Boy Color exclusive releases are distinguished through `hardware_requirements`, using `gb-original`, `gb-dual-mode` and `gbc-exclusive`. A Release has one primary platform, and one cartridge is one Release, however many systems it runs on.

**Rules for editors:**

1. **Shell color alone never decides.** Black and clear shells are only a hint.
2. Work from the physical edition: the label and box, including any compatibility statement.
3. Use documented technical evidence where available. Pan Docs defines a cartridge header value for games that also run on older units, and another for Color-only games. This shows compatibility, and doesn't decide the primary platform by itself.
4. Dual-mode primary platform: the system the physical edition is presented for. If its packaging presents both equally, record that in a note and escalate.
5. A release on these platforms is published only with exactly one of the three classifications.
6. If evidence conflicts or is missing, it stays in review. Never guess, and never create a second Release for the other system.

**Other ambiguous cross-compatible cases** follow the same approach: primary platform from the physical edition, compatibility in `release_hardware_requirements`, and no duplicate Release. Examples are Switch 2 Edition cards and discs with next-generation upgrades. Genuinely different physical editions remain separate Releases.

**Trade-off.** This depends on editors and evidence, and some older cartridges will need research. It's slower, but it avoids misclassifying thousands of releases by a rule that's known to be unreliable.

### ADR-036: The public profile card is enforced with column grants

**Decision.** Anonymous and signed-in clients can select only `id`, `handle`, `display_name`, `avatar_path`, `bio` and `country_code` on `profiles`. Owners read private settings through `public.get_my_account()`. `allow_search_indexing` and `follow_approval_required` are never public.

**Why.** RLS doesn't hide columns, and a public projection would need its own rights and could drift from the table. A missing grant also blocks filtering and sorting on the column, which would otherwise reveal its value.

**Trade-offs.** `select=*` fails for clients, so queries must name columns. Later public pages need a narrow check for indexing, and M3 needs one for follow requests. This replaces the earlier design, in which every column on `profiles` was public.

### ADR-037: Handles are unique by spelling, and normalized only against reserved names

**Decision.** `public.claim_handle()` is the only client path. Ordinary handles are unique by exact lowercase spelling, through a database constraint, and input in any case refers to the same handle. A normalized skeleton is compared only against reserved names and brand terms. A first claim allows one correction within 24 hours, and otherwise a change needs 30 days since the handle was last set. Released handles are held for 30 days by exact spelling, in `private.handle_holds`. A per-handle transaction lock covers claims and releases. This supersedes `citext` and the 3 to 30 length from the earlier design, and an earlier M2 draft that also applied the skeleton to ordinary handles, which the product owner rejected because it would stop `mike_1985` and `mike1985` coexisting.

**Why.** Aggressive normalization suits impersonation of the platform and its staff, where false positives are cheap and the names are few. For ordinary usernames, it would refuse legitimate names. The lock is needed because a unique constraint alone can't stop a claim from reading "no hold" while another transaction is releasing that handle.

**Trade-offs.** Someone can register `b4dminton` to imitate `badminton`, which leaves that to reporting and moderation. A correction allowance lets one account hold an extra name for 30 days, which is a small cost next to fixing typos. A short `exact` list and a `contains` list only for brand terms keep `badminton` valid.

### ADR-038: Avatars are written only by the server

**Decision.** Clients have no storage write access. A server-only workflow verifies the session, decodes and re-encodes every image with `sharp`, and writes with the secret key. This replaces the earlier "own folder" rule for avatars. `sharp` is a direct dependency, pinned exactly.

**Why.** Storage validates the declared type, not the content, so only a server step can guarantee re-encoding and removal of location data.

**Trade-offs.** A secret-key path exists, so its code must stay server-only, and bundle scanning checks that. Upload volume runs through the application server, which needs limits. See [Avatar storage](security-rls.md#avatar-storage) for the remaining integration.

### ADR-039: Account activation needs a verified email and a handle

**Decision.** An account is active only with a verified email, a claimed handle and `account_status = 'active'`, checked in `private.is_active_user()`. The signup trigger creates only default rows. No automatic deletion of unverified accounts exists, and seven-day retention is a proposal pending legal and product approval.

**Why.** It keeps unverified accounts out of public view, and doesn't depend on a single Auth setting.

**Trade-off.** A row exists for each unverified signup, until a retention rule is approved.

### ADR-040: Follows and blocks are reached only through functions

**Decision.** No client role, nor `service_role`, has any access to `follows` or `blocked_users`. RLS is on with no policies. All changes and reads go through `SECURITY DEFINER` functions with an empty `search_path`, which take the actor only from `auth.uid()`. A transaction-scoped lock covers each pair. This replaces the earlier design of own-row policies with triggers.

**Why.** A readable `status` would reveal rejections. Per-row visibility in RLS took 6.5 seconds for one follower page in a prototype, against about 2 ms with one permission check in a function. Functions also put each transition in one place, where it can be locked and tested.

**Trade-offs.** Each new read needs a function, and each function widens the API surface, so guards and exact grant tests cover them. Feeds in L3 will need a helper or a narrow grant.

### ADR-041: Rejection is silent

**Decision.** Approved by the product owner. A rejected request reads as "Requested" until the requester cancels. A retry during the 30-day cooldown looks real, but creates nothing actionable and doesn't change the cooldown. Removing a follower starts the same cooldown.

**Why.** It avoids telling someone they were refused, which can provoke harassment, and it stops request spam.

**Trade-offs.** A legitimate requester can wait indefinitely, seeing "Requested". A rejection row has to be stored, which is personal data awaiting retention rules under D10. A re-follow of a public account during a removal cooldown returns "Requested", which can reveal the removal.

### ADR-042: Follower counts are live, and count visible relationships

**Decision.** Approved by the product owner. `get_profile_counts` computes counts live under the same rule as the lists. Owners see exact totals. Others see relationships with public, active accounts, with no block, plus their own. There are no stored counters.

**Why.** Stored counts can drift, create a hot row and deadlocks, and can't apply a per-viewer rule. A public total would also let someone correlate two counts to infer a private follow.

**Trade-offs.** Public counts undercount, by design, and different viewers can see different numbers. A count takes about 44 ms for 50,000 followers locally, and grows with followers. A cache can sit behind the same function if measurements call for it.

### ADR-043: The audit log is private, and append-only for application roles

**Decision.** Approved by the product owner as M4-D1, M4-D2, M4-D5, M4-D7, M4-D10 and M4-D12. Staff and operator actions are recorded in `private.audit_events`, which replaces the planned `public.moderation_actions`. No API role has any privilege on it. Rows are added only through `private.record_audit()`, in the same transaction as the action, and triggers refuse updates, deletes and truncation. Admins read it through `get_audit_events()`, since the M10 integration review through `get_audit_log()` ([ADR-062](#adr-062-the-m10-integration-review-retires-the-raw-admin-reads-and-withholds-staff-reasons-from-moderators)). Staff functions require active staff, take one lock for all staff changes, and record a required reason. Moderators suspend and reinstate accounts without a staff role, admins handle staff accounts, and nobody acts on themselves. One active admin may grant `admin`, and the last active admin can't be removed.

**Why.** An audit trail is only useful if clients can't read, forge or erase it, and if no staff change can happen without a row. Keeping it out of `public` removes a whole class of policy mistakes. Plain IDs without foreign keys mean account deletion never rewrites history.

**Trade-offs.** The triggers don't constrain a database owner or superuser, so the log isn't immutable: trust there rests on credentials, backups and, later, export to write-once storage. Refused attempts aren't logged, because they roll back. One lock serializes every staff change, which is fine at staff volumes. Suspension does not invalidate existing Auth sessions or prevent sign-in (M4-D7). Protected operations enforce account status at the database level, while explicitly permitted access-reducing operations, such as unfollowing and blocking, remain available. Retention is undecided (M4-D10), and nothing removes rows until a policy is approved.

### ADR-044: Notifications come from state changes, in the same transaction

**Decision.** Approved by the product owner as M4-D3, M4-D4, M4-D8, M4-D9 and M4-D11. `public.notifications` is written only by triggers on `follows`, `blocked_users` and `profiles`, in the same transaction as the change. A follow notifies from its status transition alone, so a cooldown retry notifies nobody. A request notice is withdrawn when the request leaves pending, and a block removes every notice between the pair. Each notice is keyed to the time of the change that caused it, and repeated follows of the same account notify once per 24 hours. Preferences are in-app only and on by default. Moderation notices can't be turned off and never carry the staff reason. Deleting either account deletes the notice. Clients have no table access and use four functions, which hide a notice while its actor isn't visible.

**Why.** Triggers cover every write path, including later ones, and one transaction means a notice can't exist without its cause or the reverse. Driving notices from transitions rather than calls keeps M3's silent-rejection promise without special cases. Function-only access lets one visibility rule apply to lists, counts and marking as read.

**Trade-offs.** Inserting a notice locks both profiles, so `request_follow` and `accept_follow_request` now take those locks before the follow row, matching account deletion and avoiding a deadlock. That redefines two M3 functions, with nothing else changed. The withdrawal trigger runs as its owner, because Auth's account deletion reaches it. Cancelling and re-requesting can show a request again, once per cycle. A recipient who deletes a follow notice can get another before 24 hours have passed. There's no delivery beyond the app: no email, push or realtime. Retention is undecided (M4-D10).

### ADR-045: Catalog records are verified before they are published

**Decision.** Approved by the product owner as the M5 decisions. Catalog editors and administrators write `games`, `game_platforms`, `game_relations`, `releases` and their details only through audited functions. Verifying a record is a separate step from publishing it, and publishing requires it. A release is published with its game and platform pairing in one transaction, and a commit-time trigger keeps the three consistent. Imports and their provenance live in `private`, and an imported entry is only a candidate. Nothing invents edition details, and a serial never identifies a release.

**Why.** Imports will bring thousands of candidates, and a source's record isn't proof that a physical edition exists as described. Keeping verification apart from publication lets editors check identity in bulk where evidence supports it, without anything reaching the public catalog by default. The shared staff lock keeps M4a's guarantee that a revoked or suspended editor can't act afterwards, without making editors wait for each other.

**Trade-offs.** Editing an identity field of an unpublished record clears its verification, so editors may verify twice. Descriptive edits don't. Every change needs a reason, a small cost to editors, so the audit log never holds one made up for them. Correcting a published record keeps it published, so a mistaken correction is fixed by another correction. M7 later added exclusion and merging, for records that shouldn't stay. Relations and pairings can't be removed in M5. `service_role` has no catalog access until a job needs it.

### ADR-046: Imports run as a restricted role through audited functions

**Decision.** Approved by the product owner as the M5b security gates. The import tool connects as `catalog_importer`, a role without inheritance, membership or table privileges, which can call only the functions in the `catalog_import` schema. Those functions run as their owner and enforce every import rule: a provider's commercial use must be cleared against the exact terms reviewed, rechecked on every call; one run per snapshot and one process per run, through a lease; field locks and verified records are never overwritten; release evidence must come from a source record matched to that release; and a known source id resolves to its record, under a lock per id, before anything is created. Every run event and catalog change is audited, with no actor and the operator's reason. Imports only create candidates under review.

**Why.** An import tool with `postgres` credentials could bypass every rule, and a bug in it could publish or overwrite editorial work. Putting the rules in the database means the tool's code doesn't need to be trusted, and the tests can prove each gate against the real role.

**Trade-offs.** Matching is by title on the run's platform, so titles that differ between sources leave entries for review rather than guessing. An import fills only empty fields of unverified records, so a source's later correction to a filled field needs an editor. The role's login is set per environment by an operator, and hosted setup is still to be verified.

### ADR-047: Catalog search reads published records through read-only functions

**Decision.** Approved by the product owner for M5c. Search, the release picker and the platform list are `STABLE` `SECURITY DEFINER` functions that anyone may call, which filter every source to published, verified records and build each response from a fixed list of fields. Results are games; an exact product code or barcode is the release it identifies. Matching uses stored normalized keys with published-only indexes, so search stays in PostgreSQL as ADR-019 planned. Other titles are an editor-curated, audited `game_aliases` table: titles found by imports stay private until an editor adds them. The UI is submit-only, server-rendered, and keeps the selected release in the URL for M6.

**Why.** The read policies were written for owners and editors as well as the public, so search can't rely on them alone. Explicit filters and allowlists make what's public a property of the functions, which the tests and mutations check directly. Stored keys were needed for speed: computing them per row made a prefix search over 50,000 games take about a second.

**Trade-offs.** The keys are generated columns, so the M5b revision trigger was replaced to ignore them; otherwise every update would raise a revision. Trigram thresholds are fixed by the function for each query, whatever the session has set, and aren't tuned per query. Japanese and other non-Latin titles match by prefix and trigram similarity only. The platform list counts the whole catalog on each call, about 170 ms at 150,000 releases, so the app caches it. Editors can't search unpublished records here. M7 didn't add that; a staff catalog search is planned for M10b.

### ADR-048: Web sessions are handled only on the server

**Decision.** Approved by the product owner for M6a, local only. The app uses `@supabase/ssr` 0.12.7 and `@supabase/supabase-js` 2.118.0, pinned, in the package's documented Next.js pattern:

- `src/proxy.ts` refreshes the session before each request.
- Server code takes identity only from `getClaims()`.
- `getCurrentViewer()` reads the account through the existing `get_my_account()`.

There's no browser client, so the auth cookies are `httpOnly`. Sign-in, sign-out and the handle claim are Server Actions. **Amended by [ADR-063](#adr-063-invitations-are-supabase-native-sent-with-a-server-only-secret-key-after-the-database-authorizes):** the server now also holds the Supabase secret key, for two Auth Admin calls behind invitations, and has an invitation confirmation page and a password step. They also run without JavaScript, but their messages then don't show, so JavaScript is required for form feedback. With partial prerendering, Next.js renders the page after a no-JavaScript action by resuming the prerendered shell, and React's resume API takes no action result (`formState`); only a fully dynamic render does. Fixing it would mean giving up prerendering for those pages, so it's accepted (found in M6c). The claim goes through the existing `claim_handle`. Protected pages are checked by the proxy and again by the page. Return paths must be on this site.

There's no sign-up or password-reset page, and nothing on a hosted project changed. The seed viewer no longer appears in the header; seed content stays limited to the development preview feed. The design is in [security-rls.md](security-rls.md#web-sessions-m6a).

**Why.**
- Server-only sessions keep tokens away from page scripts, and keep one place, the proxy, responsible for refreshing them.
- Reusing the M2 functions means no new database function or privilege.
- Leaving out sign-up and reset keeps hosted registration closed until the [public-authentication blockers](security-rls.md#blockers-before-public-authentication) are resolved.

**Trade-offs.**
- Any later client-side Supabase use, such as Realtime, needs a browser client and non-`httpOnly` cookies, so this decision would need revisiting.
- Access tokens are verified locally, so a copied token keeps working until it expires, up to an hour, even after sign-out. *(Superseded for the person's own data by [ADR-067](#adr-067-a-signed-in-request-must-belong-to-a-session-auth-still-has).)*
- Pages that read the session render per request and can't be prefetched.
- Avatars aren't shown yet, because the image component would need the storage host configured.

### ADR-049: Collections are owner-only copies, added idempotently

**Decision.** Approved by the product owner for M6b (decisions D2 to D10 and B1 to B7). Each physical copy is one `collection_items` row.

- **Completeness may be left unrecorded.** It's null until the owner records it. The physical-copy rules are unchanged: a copy always has its medium, and each completeness value's rule applies once it's set.
- **Owner-only details.** Acquisition date, price and currency, notes and storage location are in `collection_item_private`. No other user, staff role or `service_role` has any privilege on it.
- **Pieces.** `collection_item_components` records which of the release's listed pieces a copy has. Pieces are identified by kind and label and checked by a trigger.
- **Owner-only in M6.** There's no read path for anyone else, and `visibility` stays `private`.
- **Idempotent adding.** The client generates each new copy's UUIDv7, so repeating a request returns the same copy. A trigger requires the id to be recent.
- **A limit.** Each owner can have 100,000 copies, checked under a per-owner lock.
- **Only usable releases.** A copy attaches only to a published release or the owner's own submission, checked by `can_use_release()` in the policies.
- **Writes and reads run as the caller.** The seven functions are all `SECURITY INVOKER`, so the policies, column grants, constraints and triggers apply exactly as they would to a direct request. No new privileged function was added.
- **Ready for M7.** `record_status` and a guard on preserved copies are in place, so M7's merge and exclusion need no change to these tables.

**Why.**
- **Unrecorded completeness keeps adding to one step without inventing data.** A default would assert something about the copy, and a new enum value would be counted as if it were real.
- **Caller's rights are the least privilege.** The owner-only policies are cheap (`owner_id = auth.uid()`, indexed), unlike the per-viewer visibility checks that pushed follows into privileged functions (ADR-040).
- **A client-chosen id is enough for idempotency.** It needs no extra column or table, and the primary key resolves concurrent repeats.

**Trade-offs.**
- **Replays and stale tabs.** A repeated request doesn't apply its details again. A stale tab that resends an addition after the copy was removed would add it back.
- **Sorting large collections.** Sorting by title, platform or acquisition date reads the whole collection, so it slows as a collection nears the limit. See the [M6b benchmark](security-rls.md#collection-system).
- **Title search.** The collection's title filter ignores case and Latin accents, but doesn't use the catalog's search keys, which callers can't reach.
- **Preserved copies.** A copy whose release is no longer readable, such as an excluded one in M7, shows no release details. M7b-2b added that read path for the owners of preserved copies (ADR-053).
- **Wrong release.** A copy can't be moved to another release in M6; the owner removes it and adds the right one. M7 adds a proper relink.
- **The limit costs a count.** Each addition counts the owner's copies.
- **A capped list.** `get_my_release_copies` lists the newest 100 copies of one release; its count is always exact.

**M7 compatibility.** M7 needs no change to these tables. `21_collection.test.sql` covers each step as M7 takes it:

| M7 step | What happens to copies |
| --- | --- |
| Submission | The submitter attaches copies at once, through `can_use_release`. They count as pending |
| Approval | The release becomes published, and its copies count as owned, unchanged |
| Rejection | The copies stay, counted as not approved |
| Merge | While merging, copies count as pending. Moving them to the target (`release_id`, by a staff function) keeps their details. A stale retry of the original request then gets `request conflict`, not a new copy. **Correction (M7a):** the trigger `drop_unlisted_components` would delete the copy's records of pieces the target doesn't list. M7b must change it to keep them, as the M6d follow-up requires (see ADR-050) |
| Exclusion | Copies become `invalid_preserved` and can't be edited, but can be removed. Moving one to a usable release clears the flag |

M7 still has to add a staff function for each step, owners' read access to an excluded release they hold copies of, and an owner's relink.

### ADR-050: Catalog submissions write the catalog's own records, privately

**Decision.** Approved by the product owner for M7a. A collector submits a missing physical release, of a published game or as a new game, by writing the existing catalog records as `unverified`, marked with `submitted_by`, through `SECURITY DEFINER` functions. `catalog_change_requests` keeps the permanent review record, with no client grant. Limit: 10 per user in any rolling 24 hours, withdrawn ones included. Region may be unknown, but stays unconfirmed. Product codes and barcodes are unverified evidence. Game, compilation or expansion. Withdrawal while unreviewed, refused while copies exist. Rejected submissions are read-only until M7b.

**Why.**
- **One set of records.** The M5 policies already make an unverified record visible only to its submitter and editors, and keep it out of search, the picker and counts, and M6 already lets the submitter attach a copy. Writing the catalog's own rows reuses all of that, and publishing in M7b is a status change, not a copy.
- **A separate review record.** `submitted_by` is cleared from catalog rows on publication, so who submitted what must live elsewhere for history and for refusing self-review.
- **No read grant on it.** Staff columns, such as the reviewer, can't leak through a policy.

**Trade-offs.**
- **New definer functions.** Necessary, because catalog tables have no client write grants by design. They're explicit, audited and tested by the `m7a` mutation suite.
- **Shared pairings.** A game's platform pairing is one row. A submission reuses an existing one silently, whoever made it. So that its existence never leaks, only catalog editors read an unpublished pairing, including its maker: otherwise not seeing it after submitting would reveal someone else's. This narrowed the M5 read policy, found in the pre-PR review. A withdrawal never deletes one that anything else uses, and M7b's review must do the same.
- **Personal data.** The request's note and snapshot, and audit rows naming the account's id, outlive the account. Their retention is left to D10 (see [Personal data in submissions](security-rls.md#catalog-submissions-m7a)).
- **Unowned records after account deletion.** Deleting an account sets `submitted_by` to null on its pending records, which stay unverified for review, and keeps the request's history.
- **Merges in M7b.** The M6 trigger `drop_unlisted_components` would have deleted copies' piece records during a merge. M7b-2a removed it (ADR-052).

### ADR-051: Catalog review goes through audited functions, and nothing is published without it

**Decision.** Approved by the product owner for M7b-1, with decisions 1 to 9 of the M7b proposal. Active catalog editors and administrators review submissions through `SECURITY DEFINER` functions: start, approve (verify and publish), request changes, reject. Editors may correct records with the M5a functions while a submission is in review. A submitter answers requested changes on the same request; a rejected submission is resubmitted as a new, linked request that counts toward the daily limit. Editors see the submitter's handle and account status, never their email or collection. Optimistic version checks, not exclusive claims. Outcomes notify the submitter in-app, always on, without naming the reviewer.

**Why.**
- **No bypass.** The M5 functions publish any verified record, so without a guard a submission could be published, even by its own submitter, without a review. A trigger on `games` and `releases` covers every path: no verification or publication while a review is active, and never by anyone who ever submitted the record, by the permanent history.
- **Reuse.** Approval calls the M5 verification and publication functions, so every publication rule and audit row applies unchanged.
- **Versions, not claims.** Two editors can work without waiting for each other, and a stale page can't act on something it didn't show.

**Trade-offs.**
- **Verification and publication happen together** for a submission, inside approval. Editors can't verify a submission ahead of approving it.
- **Lock order.** M7a's submitter functions now lock the caller's profile, then the game before the release, so withdrawal can't deadlock with publication. That redefined two M7a helpers, with their checks unchanged.
- **Deleted accounts.** Their submissions can be approved or rejected, but not sent back for changes.
- **Imports.** Private submissions are invisible to import title matching (M7b-1 follow-up), so an import with the same title creates its own candidate instead, and editors resolve the duplicate in review.

### ADR-052: Copies keep their piece records, are checked against their release under a lock, and are moved only by their owner

**Decision.** Approved by the product owner for M7b-2a, with the M7b-2 decisions. The trigger that dropped a copy's unlisted piece records when its release changed is removed. Two triggers lock a copy's release `FOR SHARE` when the copy is added or moved, and refuse one its owner can't use. Owners move their own copies with `relink_my_copy`, a dedicated `SECURITY DEFINER` function, to a usable release of the same platform.

**Why.**
- **No silent loss.** Merging moves copies, so the trigger would have deleted collectors' records.
- **No race.** The insert policy reads a snapshot, and the foreign key's `FOR KEY SHARE` doesn't conflict with a status update's `FOR NO KEY UPDATE`. `FOR SHARE` conflicts with every update of the release, so a copy and a status change always see each other.
- **No broad grant.** A column grant on `release_id` would let any client change it directly, guarded only by policies. A dedicated function changes that one column after explicit checks.

**Trade-offs.**
- **New definer code.** The relink function and the trigger functions run as their owner: a locking read needs `UPDATE` privilege on releases. They're narrow, explicit and covered by the `m7b2a` mutation suite.
- **Brief waits.** Adding a copy now briefly waits for, and holds up, an editor's change to the same release.
- **Fixtures.** Copies can no longer be written onto an excluded release, even by maintenance sessions; test data for such copies is written without triggers, as data from before an exclusion.
- **Excluded releases.** Owners couldn't read them until M7b-2b, so a preserved copy's move search wasn't filtered to its platform. M7b-2b's owner read path (ADR-053) fixed that without weakening RLS.

### ADR-053: Exclusion preserves every copy, cascades only what the publication rules need, and is restored by another administrator

**Decision.** Approved by the product owner for M7b-2b, with decisions D1 to D12 and the lock-order correction. Catalog editors exclude a release through a preview and an acknowledged, token-checked call. The pairing, game and contained games that would otherwise break the publication rules are excluded with it, unless that would strand another submission. Every active copy is preserved and recorded, and its owner notified once. Another administrator restores exactly the previous statuses, and only the copies the exclusion preserved that are still there. Owners of preserved copies read a fixed set of the excluded release's fields through dedicated functions.

**Why.**
- **Nothing lost.** Collectors' copies, private details and piece records never change, so a wrong exclusion is fully reversible, and a right one leaves the owner everything they recorded.
- **Consistent catalog.** The publication rules, now checked in both directions and through compilations, fail the whole transaction rather than leave a published game without a release.
- **No accidental restoration.** Only recorded copies, still on the release and still preserved by this exclusion, come back. An owner's later relink or removal stands.
- **No new visibility.** Catalog RLS is unchanged; the owner read path is narrow, fixed and tested field by field.

**Trade-offs.**
- **Single administrator.** Their own exclusions can't be restored until there's another administrator (D5).
- **Locks.** An exclusion briefly locks the release's game, the games it contains, and the profiles of everyone it affects. Catalog edits to that game and those accounts' deletion wait for it: about 265 ms for 2,000 copies.
- **Retries.** A preview goes stale when the release, its submission or the cascade changes, including when a submitter's or reviewer's account is deleted; the editor reviews again. In a narrow race with an account deletion, the call fails with a retryable conflict.
- **More privileged code.** Eight new `SECURITY DEFINER` functions, covered by the `m7b2b` mutation suite.

### ADR-054: Merging moves every copy with everything recorded, never changes the target, and keeps unpublished merges private

**Decision.** Approved by the product owner for M7b-2c, with decisions D1 to D15 and its safeguards. A catalog editor (an administrator, for a published source) merges a duplicate into a published release of the same platform and physical format, through a preview and a token-checked call that acknowledges every differing field by name. Copies move with their conditions, private details, piece records and `updated_at`. External references move with a permanent record of each. Earlier merges are repointed, so redirects take one step. The source and its history stay. A merged release is public only if it was published when merged.

**Why.**
- **No silent loss.** Collectors' records never change except the release a copy is on, and a duplicate copy is never folded into another.
- **No accidental truth.** The target is never edited by a merge: values come over only through the audited M5 edit functions, under their field locks.
- **No new visibility.** Merging an unpublished submission would have published it through the M5 read policy; that policy was narrowed first, and tested before any merge existed.
- **No chains, no cycles.** Only published releases take a merge, and a merged release never does.

**Trade-offs.**
- **No unmerge.** The records keep what one would need. Owners can relink their own copies at any time.
- **Administrators for published merges.** A published merge changes public addresses and many collections, and can't be undone.
- **Client-side redirects.** Inside the game page's streamed boundary, the redirect is the one Next.js emits there, not an HTTP 308. A 308 would need the proxy to call the database on every release link. A known limitation, not a security one.
- **Cache.** A merge expires the public catalog's cache tag, all of it: merges are rare, and the catalog refills on the next reads.
- **Locks.** A merge locks both games, both releases and the profiles of everyone it affects: about 374 ms for 2,000 copies.
- **More privileged code.** Six new public `SECURITY DEFINER` functions and one public read, covered by the `m7b2c` mutation suite.

### ADR-055: The Owner is a protected record, its authority needs mature MFA, and recovery is an audited operator procedure

**Decision.** Approved by the product owner for M8, the Superadmin Foundation, with [decisions D1 to D19](#m8-decisions-the-superadmin-foundation), the addendum A1 to A5, and the M8a to M8d checkpoints. Built in five migrations, `20261116100000` to `20261118100000`.

- **One Owner, as a record.** `private.platform_owner` names exactly one account once assigned. It's assigned by an operator in SQL, and changes hands only by a two-step transfer or a break-glass recovery. Nothing reads ownership from a token, metadata or a role.
- **Identity protects, eligibility empowers.** Being the designated Owner alone protects the account: from deletion by any path, from suspension in the app, from losing the administrator role, and from replacement. Acting as Owner also needs good standing, a live verified session, two TOTP factors registered for 24 hours, no pending recovery and a verification in the last 10 minutes.
- **The Owner's only powers** are administrators (granting, revoking, suspending), transfer, the successor and the succession document. No collection, purchase-data, catalog, review or no-self-review rule mentions the Owner.
- **MFA for every staff privilege, checked live.** `has_staff_role` reads Auth's live session, factor and claim rows, so a signed-out or downgraded token gains nothing. Sensitive actions, published merges included, need a verification in the last 10 minutes.
- **Factor maturity from our own ledger.** A factor is registered at the database's time, by a function with no arguments, in a table no client can touch and nobody can update.
- **The staff matrix in the database.** Only the Owner changes administrators, nobody changes themselves or the Owner, and every refused attempt by verified staff is committed with its audit row and nothing else.
- **Recovery is an operator procedure.** After a 72-hour hold, with Owner authority frozen, the target's confirmation in the app, and the succession document's fingerprint checked. A reassignment removes the previous Owner's administrator role. The Owner may cancel, and a disputed recovery, only an operator can cancel. See the [runbook](../operations/owner-recovery-runbook.md).
- **One `/admin`,** with each section shown only to its roles and `notFound()` for everyone else. `/review` redirects there. Settings → Security enrolls, verifies and removes TOTP factors through Supabase Auth.

**Why.**
- **The highest-value account can't be removed by mistake or by one stolen credential.** A password and one device don't give full authority for 24 hours, and losing a device never removes protection.
- **The database is the boundary.** Every decision the pages show is made again by the functions, so direct API calls get the same answers.
- **No hidden doors.** No bootstrap endpoint, no second Owner, no automatic successor. Every operator step is a named function with an audit row.
- **Refusals need a record.** An attempt on the Owner by verified staff is evidence, so it commits instead of rolling back.

**Trade-offs.**
- **Infrastructure keys bypass everything.** `postgres`, superusers, the Auth secret key and dashboard members can disable triggers, edit records and remove factors. `pgaudit`, named key holders and alerts are launch prerequisites (D18).
- **A dependency on GoTrue internals.** The live checks read three Auth tables. A changed schema locks staff out rather than exposing anything, and a contract test guards upgrades.
- **TOTP replay.** GoTrue accepts a code twice within its 30-second window. There's no custom TOTP implementation.
- **Slower recovery.** The 72-hour hold and 24-hour maturity delay a legitimate Owner too. That's the price of resisting a takeover.
- **Procedural controls.** That the operator isn't the beneficiary, that approvers are independent, and identity checks can't be enforced by the database. They're recorded in case files.
- **A single lock** serializes every staff, transfer and recovery change, as in M4. Fine at staff volumes.
- **Enrollment needs JavaScript** to show the QR code and setup key.
- **More privileged code.** Nineteen new or replaced public `SECURITY DEFINER` functions, covered by the 92 `m8` mutations.

### ADR-056: Dark Mode is the only supported appearance for the initial release

**Decision.** This is a product and visual-design decision by the product owner, made at the end of M8. My Game Dex supports Dark Mode only for its initial release: dark charcoal backgrounds, purple accents, warm lighting and premium retro-collector visuals.
- The root layout's `class="dark"` stays unconditional.
- There's no theme switcher and no `prefers-color-scheme` rule.
- Nothing reads `user_preferences.theme`.
- Light Mode isn't offered or advertised, and the light set in `globals.css` is unused.

**Why.** The planned visual direction is dark. A second appearance would double the visual and accessibility review for no initial benefit.

**Consequences.**
- **Accessibility requirements apply to Dark Mode.** `npm run app:a11y-checks` enforces them there.
- **Light Mode is diagnostics only.** The suite also applies the light tokens, but only as diagnostics: listed apart, never counted as passes, and not a release requirement. Those tokens currently fail WCAG AA color contrast, so Light Mode must not be described as accessible. `A11Y_LIGHT=enforce` keeps the strict checks for future Light Mode work.
- **A supported route to Light Mode would be a release blocker.** If a user could switch to it, through a switcher, a stored preference or the browser's setting, it would have to pass the same checks first.
- **The stored preference does nothing.** `user_preferences.theme` (M2) still accepts `system`, `dark` and `light`, with no effect.

### ADR-057: The admin overview shows role-scoped, bounded counts, decided in the database

**Decision.** M10a. `/admin` shows operational counts from one read, `public.get_admin_overview()` (migration `20261119100000`).
- **Who may read it:** staff with an active account, a live verified session and a staff role. Everyone else gets the generic refusal.
- **Sections by role:** catalog editors get the review queue by status, the oldest waiting submission, open import reclassifications, unpublished games and releases, and merges in the last 30 days. Moderators get suspended accounts. Administrators get those plus active exclusions, staff by role and refused staff actions in the last 7 days. A section a caller may not read is null; the database decides, not the page.
- **Aggregates only:** numbers, and one timestamp. No handle, email, title, reason or collection data.
- **Bounded:** every count stops at 10,000, and the page says "10,000 or more".
- **Not audited,** like the other staff reads, because it writes nothing.

Also in M10a, every catalog page (review, merge, exclusion and their histories) uses the same access check as the rest of `/admin`. Staff signed in without their authenticator are sent to verify, and come back to the page. Everyone else gets `notFound()`. Who may open each page is unchanged.

**Why.** Staff need to see the work waiting without opening each queue. The database is the boundary, so the scope of each count is enforced where the data is, and a direct API call gets the same answer as the page.

**Trade-offs.**
- **One more privileged read.** It's `SECURITY DEFINER` because the counts cover private tables. It's covered by `35_admin_overview` and the 15 `m10a` mutations.
- **Counts, not trends.** There's no history or charting. A count above the cap isn't exact.

### ADR-058: Catalog history is an allow-listed view of the audit log

**Decision.** M10b, for decision D4. Catalog editors and administrators read one record's history through `public.get_catalog_record_history()` (migration `20261120100000`), alongside a staff search of every catalog record and read-only game and release records ([security-rls.md](security-rls.md#catalog-records-and-history-m10b)).
- **No second log.** History reads `private.audit_events`, which every catalog action already writes in the same transaction. Nothing new is recorded, so history can't disagree with the audit log.
- **Two allow-lists.** Only the 22 catalog actions in `history_actions()`, and only the metadata keys `history_event_json()` copies. A new action or key stays hidden until it is added on purpose; the stored metadata is never returned.
- **The record's events only,** matched by the record's id in a named field and by the kind of record.
- **People as kinds.** An import, the submitter (never named), or a staff member by handle. No record or result says who submitted, verified, locked or merged it.
- **Exclusions stay administrators'.** History shows an exclusion's reason code to editors, never the staff reason, the copies or the exclusion's id.
- **Bounded:** pages of at most 50, by keyset on the event id.

The full audit log (`get_audit_events`, now `get_audit_log`) stays administrators' only.

**Why.** Editors reviewing or merging a record need to see what was done to it, and why, without the full audit log, which also holds account, staff and Owner events. Reading the existing log keeps one source of truth; the allow-lists keep its private parts out by construction rather than by filtering what's known to be sensitive.

**Trade-offs.**
- **Four more privileged reads.** They're `SECURITY DEFINER` because history and provenance are private. They're covered by `36_catalog_records` and the 20 `m10b` mutations.
- **Staff reasons reach editors.** A reason was previously visible only in the review history and the administrators' audit log. Staff write them for the record, and exclusion reasons stay excluded.
- **Matching by metadata.** Events name records in their metadata, so history depends on those keys staying as they are. The new indexes cover each key, and the tests fail if a key changes.

### ADR-059: A record's creator is kept privately, and never reviews it

**Decision.** M10c, for decisions D2 and D3, with the product owner's design decisions D-1 to D-8 (migrations `20261121100000` and the review fixes `20261121100100`; [security-rls.md](security-rls.md#catalog-editing-provenance-and-no-self-review-m10c)). Catalog editors create, edit, verify and publish games and physical releases in `/admin`, through the M5 functions.
- **Provenance in a private table (D-1),** not a `created_by` column: `private.catalog_record_origins`, one row per game and release, written by an insert trigger from the session itself (a staff member, a member's submission, the importer's login, or maintenance) in the same transaction. No grants; a trigger refuses every change. `submitted_by` keeps its M7 lifecycle unchanged.
- **No self-review (D2, D-4),** in the review guard: the creator never verifies or publishes their record, nor a game through one of its releases, nor merges or excludes it, whatever their role. A record its creator verified is verified again by someone else.
- **Unknown provenance fails closed (D-2):** legacy records with no evidence are `unknown`, never guessed to be an import or the system. Only an administrator may verify or publish them, and a second one publishes what the first verified. Both are audited as unknown provenance.
- **A deleted creator (D-3):** the foreign key clears the id and marks the creator removed, so the row still says a person created it. Nothing else about them is kept; the audit log keeps its plain ids under the existing retention question (M4-D10). Account deletion keeps working.
- **Recent MFA (D3, D-5, D-6):** a TOTP verification in the last 10 minutes for verifying, publishing, approving, changing published content, excluding a published release and restoring one, checked first in each function, and behind them in the guard and a pairing trigger (D-8).
- **Revision-bound verification (D-7):** a verification is kept with the revision it attested, any change to an unpublished record ends it, aliases and relations included, and publication needs one that matches. A restoration isn't verified again, so nothing changes an excluded record (review fix: removing an alias was the one gap); a relation needs a recent verification when either game is published.

**Why.** The review guard only knew about member submissions, so an editor could create a record and publish it alone. Recording the creator in the database, from what the database knows about the session, and checking it in the guard every write path goes through, closes that for every function at once, existing and future. A private table keeps the identity out of the public catalog tables and their grants, revision trigger and readers, which a column would have reached. Binding a verification to its revision means what was verified is what's published.

**Trade-offs.**
- **Two people for every record.** A team of one can't publish what it creates; an administrator can't resolve their own record either.
- **More re-verification.** Descriptive edits, aliases and relations now end a verification, and a status change makes it stale.
- **Test churn.** Fixtures that created and published as one editor now use a second one.
- **Unknown records need two administrators** to verify and publish.
- **Covered by** `37_catalog_provenance`, `db-catalog-checks`, `app:editing-checks` and the 20 `m10c` mutations.

**Accepted with M10c** (the product owner's review of commit `c4e2b6b`):
- `set_game_relation` needs a recent verification whenever either game is published.
- `remove_game_alias` refuses excluded and merged games.
- A restoration brings back previously reviewed content, because every editor function refuses an excluded record.
- Indirect publication and pairings were examined, and no bypass was found.

**Deferred hardening (M10c review).** A database trigger that refuses changes to an excluded record, whichever function makes them, so that keeping excluded records unchanged doesn't rest on each editor function. It needs its own compatibility analysis first: account deletion (which clears `submitted_by` and `verified_by` on those rows), foreign keys and their cascades, restoration, and legitimate maintenance. Not in M10d, unless a new material vulnerability is found, which would be reported before the scope grows.

### ADR-060: Imports and the system are read-only views for administrators, and reference data is the public tables

**Decision.** M10d, for decisions D5, D7 and D8 (migration `20261122100000`; [security-rls.md](security-rls.md#reference-data-imports-and-system-m10d)).
- **Reference data (D5)** is read from the public, migration-managed tables, as anon and cached, like the editing forms' choices. No function, form or endpoint changes it. The pages are for catalog editors and administrators, who use the lists.
- **Imports (D8)** are five new reads, for administrators only, each `SECURITY DEFINER` with an empty `search_path`, `require_active_staff('admin')` first and bounded results: `get_import_providers`, `get_import_runs` (1 to 100 a page, by source and status), `get_import_run` (the operator's existing pilot report, `catalog_import.run_report`, reused), `get_import_run_records` (1 to 100 entries a page, by status) and `get_system_status`. They return fixed keys: never a lease id, checkpoint, raw payload or match notes, and only the numbers in a run's stats.
- **The reclassification queue** is a catalog page for editors, using the existing `get_catalog_review_queue` and `resolve_catalog_review` (M5b), unchanged. Resolving is the only write in M10d: it needs an active editor with a verified session and a reason, closes only the queue item, changes no catalog record, and is audited (`catalog_review_resolved`), so the record's history shows it. It needs no recent verification, as in the D3 matrix, because nothing public changes.
- **The system view (D7)** shows the applied migrations, whether the importer role can log in, runs in progress and stopped ones, sources and their clearance, counts, and the fixed policies. Not the Owner record, which the ownership page shows. No setting, environment value, address, key, version string or role detail beyond the importer's login.

**Why.** Everything shown already exists and was already authorized; the reads only make it visible, in the database's own words, to the role D8 names. Reusing the pilot report keeps one definition of a run's results. Keeping the queue on the existing functions means no new privileged write.

**Trade-offs.**
- **Editors don't see import runs.** An item in their queue links to its release, not its run; administrators see both.
- **Reference data is cached for hours,** which is right while only a migration changes it.
- **Covered by** `38_imports_system`, `db-mfa-checks` section 9, `app:reference-checks`, `app:a11y-checks` and the 18 `m10d` mutations.

**M10e privacy review** (migration `20261123100000`). Reusing the pilot report whole also passed on what it counts by: values copied from the raw source payload (release types and flags), and an unbounded number of reasons. And a failed entry showed the importer's database error message, an internal diagnostic. Nothing secret was reachable, and only administrators could read it, but the reads no longer rely on that. The report is now rebuilt from an explicit allow-list (`private.import_report_safe`). A failed entry shows only its status, an ignore reason is cut to 200 characters, and a run's stats keep only the five staging counts.

### ADR-061: Accounts, audit and staff are allow-listed reads over the M8 functions

**Decision.** M10e (migration `20261123100100`; [security-rls.md](security-rls.md#accounts-audit-and-staff-m10e)). Four reads, and no new write:
- **Accounts** (moderators and up): `search_accounts` finds handles by their start, never by email or name, 1 to 25 at a time; `get_account_summary` adds how often an account was suspended and reinstated, refused status changes, the last change and its last 20 events. Moderators see status history; administrators also staff-role history.
- **Audit** (administrators): `get_audit_log` adds filters by kind and outcome, keeps the handle filters, bounds every range to 366 days, and returns each event through one allow-list of details, with a link target for a game or release. Catalog editors keep the narrower record history (ADR-058).
- **Staff** (administrators): `get_staff_overview` adds role counts, each member's standing as a fixed word, their verified and mature authenticator counts, when they last acted, and recent staff changes.
- **Writes stay the M8 functions,** unchanged: the pages only explain what they don't offer (your own roles, the Owner's, administrators for anyone but the Owner, paused Owner authority), and the database decides.

**Why.** Staff need context to act fairly: an account's history before suspending it, which staff can actually use their roles, and the log narrowed to what matters. Each of those is a read of data the database already holds. Reusing the M8 writes keeps one place that decides the authority matrix, the step-up and the audit row.

**Trade-offs.**
- **Readiness is counts only.** An administrator sees that a colleague has one authenticator, never which one or when it was used.
- **Moderators saw the reasons other staff gave** for an account's status changes; they don't see staff-role history or the audit log. Superseded by [ADR-062](#adr-062-the-m10-integration-review-retires-the-raw-admin-reads-and-withholds-staff-reasons-from-moderators): moderators now see what happened and why it was refused, not the free-text reason.
- **`get_audit_events` (M8d) stayed,** returning raw metadata to administrators over the API, for compatibility with its tests. Retired in [ADR-062](#adr-062-the-m10-integration-review-retires-the-raw-admin-reads-and-withholds-staff-reasons-from-moderators), with `get_staff_members`.
- **Covered by** `39_accounts_audit_staff`, `db-mfa-checks` section 10, `app:admin-checks` section 6b, `app:a11y-checks` and the 20 `m10e` mutations.

### ADR-062: The M10 integration review retires the raw admin reads and withholds staff reasons from moderators

**Decision.** The product owner's M10 integration review (migration `20261124100000`; [security-rls.md](security-rls.md#m10-integration-review)):
- **`get_audit_events` and `get_staff_members` (M8d) are dropped,** each by exact signature, guarded, with `RESTRICT`. `get_audit_log` and `get_staff_overview` (M10e) replace them. No audit row is changed or deleted, and retention is unchanged.
- **Moderators' account history withholds the reason** staff wrote, keeping the action, outcome, time, handles and allow-listed details, including a refusal's code. Administrators keep every reason.
- **The overview's refusal count** links to the refused events.

**Why.** The app stopped using both reads in M10e, but `get_audit_events` still handed any administrator calling the API the raw metadata the page's allow-list hides: account ids, a succession document's fingerprint, plan tokens. An unused path that bypasses an allow-list is a liability, not compatibility. A status reason is free text that may carry internal notes; a moderator judging an account needs what happened and when, not another staff member's words.

**Trade-offs.**
- **A script that called the retired reads breaks,** by design. None exists in the repository; operators read `private.audit_events` with SQL, as before.
- **A moderator can't read a colleague's reasoning** for a suspension; they ask an administrator, who sees it in the account and the audit log.
- **Covered by** `14_audit`, `34_admin`, `39_accounts_audit_staff` (85), `db-audit-checks`, `db-mfa-checks`, `app:admin-checks`, and six `m10i` mutations; the historical mutations on the retired reads now target the replacements.

### ADR-063: Invitations are Supabase-native, sent with a server-only secret key after the database authorizes

**Decision.** M11a-1 (migrations `20261125100000`, `20261125100100`; [security-rls.md](security-rls.md#invitations-and-registration-m11a-1)), local development only. The private beta is invitation only:

- **Auth sends the invitations.** The server calls Auth's Admin API (`inviteUserByEmail`) with the secret key; Auth sends the email (Mailpit locally) with the app's own template, which links to `/auth/confirm` with the token's hash.
- **The database decides first, and checks Auth after.** Every action starts with a SECURITY DEFINER function in the administrator's own session: active administrator, a verification in the last 10 minutes, a reason, limits (20 open per administrator, 200 in all; one resend per 10 minutes, five per invitation), an audited ledger row (`private.account_invitations`, no API access). Only then the Admin API call, with what the function returned. The database then reads `auth.users` itself to record the outcome, never the server's word.
- **The secret key** is the server-only `SUPABASE_SECRET_KEY`, used only in `src/features/auth-admin/server.ts` (marked `server-only`), for two operations: send an invitation and ban an invitee. No deletion, no unbanning, no generated links, no data queries, nothing logged. This amends [ADR-048](#adr-048-web-sessions-are-handled-only-on-the-server).
- **Revocation never deletes an account.** It's recorded and audited first, which at once blocks the invitee's password step and handle claim in the database; then the server bans the account in Auth; then reconciliation reads the ban back. A ban that fails leaves "revoking", which still blocks onboarding and can be retried. An invitee who accepted before the ban is recorded as revoked after acceptance and stays banned; nothing unbans them automatically. An invitee who has already chosen a handle has a working account: that's a suspension.
- **Accepting is an explicit POST.** `/auth/confirm`'s GET shows a button; only its POST calls `verifyOtp`, so mail scanners can't spend the single-use token. Then `/welcome/password`, then the existing handle claim.
- **The password step is authoritative.** `complete_my_password_setup` records it only when Auth's own log (`auth.audit_log_entries`, `user_updated_password` for this account, after it accepted) shows the change, and `claim_handle` refuses an invitee whose step isn't recorded or whose invitation is being revoked. Accounts not made by invitation are unaffected.
- **Hosted:** `[auth] enable_signup = false` with the email provider left on, documented for the pre-beta launch tasks and tested on the isolated test stack (configuration B). Hosted settings, SMTP and real invitations are pre-beta tasks, not part of this milestone.

**Why.** The M11a-0 spike showed Auth's invitation works with public sign-up off, that turning the email provider off breaks sign-in and recovery, that Auth's delete has no guard against an accepted account, that a ban makes the invite link fail, that a GET on Auth's own link spends the token, and that simultaneous verifications of one token can all succeed. The design keeps public registration closed, reuses Auth's email delivery, keeps every rule in the database, and makes every step safe to repeat.

**Trade-offs.**
- **A secret key in the server runtime** widens what a server compromise exposes. Narrow use, server-only, bundle scans (`secrets:bundle`) and no logging limit it.
- **The password step depends on Auth's audit log table**, a GoTrue internal. It fails closed (the step stays undone) if that table changes; hosted projects must keep writing Auth audit logs to the database (a pre-beta check).
- **Revoked invitees' accounts remain in Auth, banned.** Removing them is an operator task, under the retention policy (D10).
- **The invitation flow needs the template**, set on the test stack only; the development stack keeps its configuration, so invitations aren't available there until it's given the template and the key.
- **Lost authenticators** are operator-assisted only ([runbook](../operations/lost-authenticator-runbook.md)).

**Amended in M11a-2** (migration `20261126100000`, approved by the product owner), after a review found that an administrator could tell which addresses already had an account: M11a-1 gave such an address no ledger row and no count, skipped the limit check for it, audited it with a distinct code, returned no id from the API, and handed the server's address back to whoever asked for a resend.
- **Every accepted address gets a row and the same answers.** An address Auth already holds gets a "withheld" row: nothing is ever sent for it, it's never linked to that account and never blocks its onboarding, and nothing an administrator can read (list, counts, limits, audit details, API responses, refusals) differs from an invitation that was sent. While invitation emails are failing, withheld rows show as failed too.
- **The steps that depend on what Auth holds are the server's only.** Whether and where to send (`invitation_delivery_plan`), recording what Auth did (`record_invitation_delivery`), the account to ban (`invitation_revocation_target`) and reconciling (`reconcile_invitation`) are executable by `service_role` alone, which the server calls with its secret key after the administrator's own function has authorized the step. The authorization (active administrator, recent MFA, reason, limits) and its audit row stay in the administrator's session; the audit rows for the server's steps name the administrator who asked. So **the secret-key module now makes four database calls** as well as its two Auth Admin calls, still no others.
- **Timing.** Sending takes at least two seconds whether or not an email goes out, so the two answer alike; a send slower than that still stands out.
- **A handle claim and a revocation are serialized** on the invitation row: `claim_handle` locks it before deciding (it read it without a lock, so both could succeed).

### ADR-064: Password recovery is Supabase-native, verified by POST and bound to the browser that opened the link

**Status:** accepted (M11a-2). **Context:** members need to reset a forgotten password, change it, and end other sessions, without the app learning or revealing who has an account, and without a reset weakening TOTP or staff protections. Auth's own reset link is spent by a GET (M11a-0), and its `/recover` answer differs for an address with an account when asked twice in a minute.

**Decision.**
- **Supabase Auth's recovery, as the person.** `resetPasswordForEmail`, `verifyOtp({ type: "recovery" })` and `updateUser`, with the publishable key only: no secret key, no Auth Admin call, nothing that bypasses Auth's rules.
- **One answer.** `/forgot-password` answers every address alike, whatever Auth says, in at least two seconds.
- **POST-verified links.** The template links to `/auth/confirm` (shared with invitations); the GET shows a button, the POST signs out whoever is signed in here, then verifies.
- **Bound to the browser and the hour.** An httpOnly cookie holds the new recovery session's id; `/reset-password` accepts only that session, within an hour of the link. Anywhere else, the current password is needed.
- **TOTP first.** A recovery session is aal1; with an authenticator, the existing verification page takes it to aal2 and back. No factor is removed; a lost one is the operator's runbook.
- **Changing** asks for the current password (checked in a detached session that's ended at once), then Auth's rules: aal2 with an authenticator, a sign-in within a day.
- **Signing out everywhere** is Auth's global sign-out, separate from signing out here. The pages said that a device in use can keep working for up to an hour: access tokens stayed valid until they expired (demonstrated in M11a-2), though staff functions stopped at once. Since [ADR-067](#adr-067-a-signed-in-request-must-belong-to-a-session-auth-still-has) every protected path stops at once.

**Consequences.** No database change. Auth's behaviour is pinned by `db-password-checks`, to be rerun on staging. Residual risks (timing, tokens until expiry, Auth accepting a password change from any day-old session without the current password) are listed under [Production launch prerequisites](security-rls.md#production-launch-prerequisites-m8).

### ADR-065: The profile editor reuses the M2 rules, and the M2 avatar workflow unchanged in its checks

**Status:** accepted (M11a-3). **Context:** members need to edit their public card (display name, bio, photo) and see their handle and collection privacy, without a second set of validation rules that could drift from the database's, and without a new privileged path to Storage.

**Decision.**
- **Name and bio as the person.** An update of the person's own row with the publishable key; the M2 column grants, `profiles_update_own`, `CHECK`s and trigger decide. The page mirrors the rules (tested against the migration) and maps the database's own refusals to fixed messages. No new field, no handle policy change.
- **The photo through the M2 workflow.** Server Actions (not a route handler) call `replaceAvatar` and `removeAvatar`, so Next.js's same-origin check and body limit apply before the action runs. The limit is raised from 1 MB to 2 MB plus 64 KB for every action, the smallest that fits a 2 MB image. The secret key stays server-only and is used only as M2 designed: the avatars bucket and `set_avatar_path`, in the verified user's own folder. No storage policy changes; the browser has no write path.
- **One addition to the workflow:** removing a user's own leftover files older than ten minutes after each change, so a partly failed change is cleaned up by the next one. Same key, same folder, same operations (list, remove) as M2's deletion.
- **The public card is shown as it's saved,** with what's public said plainly; collection sharing waits for M11c (`/u/[handle]` too). `/profile` sends a signed-in person to `/settings/profile`.

**Consequences.** No migration. The ended-session gap from M11a-2 now also covers name and bio saves (not the photo). Per-user upload rate limits and a global orphan sweep remain. Deferred security decisions are listed in [security-rls.md](security-rls.md#security-decisions-deferred-m11a-3).

### ADR-066: The data export is a streamed download read as the person, and expensive requests are counted in the database

**Status:** accepted (M11a-4a). **Context:** collectors need a portable copy of their own data, including private purchase details, without a privileged read path; uploads and exports are expensive enough to need per-account limits that hold across app instances.

**Decision.**
- **A POST route handler** (`/settings/account/export`), not a Server Action, because the answer is a file download; it checks the origin itself, since Next.js's Server Action check doesn't apply to route handlers.
- **Read as the person**, with the publishable key, through existing owner-scoped reads (RLS, `get_my_account`, `get_my_preserved_titles`, the submission functions). No service role, no new read function.
- **Streamed JSON in pages of 200 copies**, keyset by id, with a final `"complete": true`; a failure ends the stream unfinished rather than producing a file that looks complete.
- **Stronger than ordinary reads:** aal2 for accounts with an authenticator, and a live-session check with Auth, because an export is a bulk copy of private data.
- **`take_request_slot`**, a small definer function over a private table, counts exports (3 an hour) and photo uploads (10 an hour) per account. Fixed kinds and limits; nothing the client chooses.
- **The 2 MB action body limit is narrowed to `/settings/profile`** by the proxy, which refuses other POSTs that declare more than 1 MB.

**Consequences.** One migration (a table and a function). The export is a technical copy, not a legal access response (D10). Revoked sessions can still read and write ordinary data elsewhere until their token expires; the narrow fix is analysed in [session-and-password-decisions.md](session-and-password-decisions.md), and deletion and retention in [account-deletion-d10.md](account-deletion-d10.md), both for decision.

### ADR-067: A signed-in request must belong to a session Auth still has

**Status:** accepted (M11a session-revocation checkpoint). **Context:** an access token stayed usable for up to an hour after the session it came from was ended (sign-out everywhere, a reset, a change), because PostgREST verifies tokens by signature only. Staff functions already checked the session (M8b); collector data didn't.

**Decision.**
- **One fail-closed definer helper,** `private.session_is_live()`: the token's signed `session_id` must be a row in `auth.sessions` for this user, not past `not_after`.
- **Added where the person's own data is reached:** the shared guards (`is_active_user`, `require_verified_user`), the owner-only policies that used neither, the own-submission branch of the catalog rules, and the owner-scoped functions that checked only `auth.uid()`. Always once per statement.
- **Not added to public reads:** the published catalog and public profile cards behave the same for an ended session as for a signed-out visitor.
- **Database-side, not a PostgREST pre-request hook.** A hook would cover every request in one place, but it depends on a role setting, which fails open if missing, and it would refuse public reads too. This way each object checks itself, and a pgTAP coverage rule keeps new functions honest.
- **The signed-in password change passes `current_password` to Auth,** ready for hosted "require current password", which was verified on GoTrue v2.197 (recovery sessions exempt, aal2 still required).

**Consequences.** One migration (15 functions redefined with one condition each, 10 policies, one helper). A statement already running when a session ends completes; later ones are refused. The cost is tens of microseconds on small queries and within noise on large ones. The pages now say other devices are signed out, without the hour caveat. Storage and Realtime paths would need their own check if clients ever use them.

## Risks to watch

| Risk | Mitigation |
| --- | --- |
| A policy mistake exposes private data | Owner-only table for purchase data, policy matrix tests, schema guards in CI |
| The secret key leaks or is misused | Server-only, never `NEXT_PUBLIC_`, limited to named jobs, rotation plan |
| Per-viewer data enters a shared cache | Rule in [security-rls.md](security-rls.md#operations-requiring-server-side-authorization), with code review and a test for it |
| RLS helper calls slow large queries | Scope by owner, index, measure with `EXPLAIN`, precompute cross-owner views |
| The catalog review queue falls behind | Build admin tools early. Submitters can already use their entries, so a delay doesn't block them. Any trusted-contributor program must still not auto-approve without a new product decision |
| An unverified record leaks into a global surface | Published-only indexes, status filters in jobs using the secret key, and tests for each surface |
| Private defaults leave the platform looking empty | Onboarding that invites publishing, and tracking the share of collections made public |
| A profile card reveals more than users expect | Cards are public by decision, and `country_code` is optional. Keep the settings screen clear about what's always visible |
| A Game-Key Card or similar gets past review | A written guideline for editors, and users can report catalog errors. A published record can move to `excluded`, which preserves every owner's items as invalid records |
| Market data is thin or uneven | Treat markets as known distribution only. Never present absence as fact |
| Classification rules are applied inconsistently | The examples in ADR-026, and a recorded note on judgment calls |
| Cover art rights block the visual design | Resolve [D15](#needed-before-catalog-work) before committing to a provider |
| Self-reported data is treated as fact | Don't present ownership, valuation or achievements as verified |
| Credential attacks succeed because Auth doesn't throttle them | No throttling or lockout was seen locally. Application-level throttling and CAPTCHA are hosted registration requirements |
| A rejected or removed user seeks another route to contact someone | Silent rejection and blocks limit this, and reporting (L4) is required before launch |
| New RLS policies add per-row functions on large tables | Compute once per query, and measure with `supabase/benchmarks/` |
| Two related accounts deleted at the same moment deadlock | Postgres aborts one, with nothing half-deleted, and a retry succeeds. Accepted as a known limitation. See [Notifications](security-rls.md#notifications) |
| A user is deleted without the avatar workflow | Their public file stays behind. Route all deletion through `deleteAccountWithAvatars()` |
| Someone with owner credentials edits the audit log | Triggers only stop application roles. Limit owner credentials, keep backups, and plan an export to write-once storage before launch |
| A suspended user keeps a live session | Suspension does not invalidate existing Auth sessions or prevent sign-in. Protected operations enforce account status at the database level, while explicitly permitted access-reducing operations, such as unfollowing and blocking, remain available. An Auth-level ban is deferred (M4-D7), and needed if non-database features are added |
| A new code path writes rows that notifications reference, in a different lock order | Lock the referenced profiles before the referencing rows, as the follow functions do. The API checks force this race for accept and request |
| Notifications and audit events grow without limit | Nothing removes them until M4-D10 sets a retention period. Both tables are indexed for a later purge |
| Someone with infrastructure keys takes over the Owner (M8) | Protections stop application and API roles only. Name the key holders, `pgaudit`, alerts on Owner changes, MFA on dashboard accounts (D18). The runbook's procedural controls |
| A Supabase upgrade changes Auth's tables (M8) | The live MFA checks fail closed and log it, locking staff out. Run `31_auth_contract.test.sql` and `db:verify` before every upgrade |
| A captured TOTP code is replayed (M8) | Possible for about 30 seconds by someone already holding a session (GoTrue). The 10-minute window still holds |
| The Owner loses both authenticators (M8) | A factor reset by the runbook: 72-hour hold, then 24-hour maturity. A second authenticator on a separate device is the backup, since recovery codes aren't available |

## Phase 2B plan

Accepted by the product owner as the implementation roadmap. Work proceeds one step at a time, with constraints, grants, RLS policies and tests delivered together, and each step needs authorization.

### Table classification

**First phase** means the first migration phase. **Core** is required for the first functional version: accounts, catalog, physical collections, shelves and privacy. **Supporting** is required for integrity, authorization or catalog correctness. **Later** can be added without changing the initial architecture.

| Table | Purpose | Class | Depends on | First phase | Why |
| --- | --- | --- | --- | --- | --- |
| `profiles` | Public user card | Core | `auth.users` | Yes | Everything is owned by a profile |
| `user_preferences` | Private settings and defaults | Core | `profiles`, `region_codes` | Yes | Holds the private defaults under D2 |
| `platforms` | Consumer gaming platforms | Core | None | Yes | Every Release needs one |
| `platform_names` | Regional names and aliases | Supporting | `platforms`, `region_codes` | Yes | P1 and P2 |
| `media_formats` | Physical media reference | Supporting | None | Yes | P7, and `releases` depends on it |
| `platform_media_formats` | Valid platform and format pairs | Supporting | `platforms`, `media_formats` | Yes | Composite key on `releases` depends on it |
| `hardware_requirements` | Requirement definitions | Supporting | `platforms` | Yes | R1 |
| `release_hardware_requirements` | Release requirements | Supporting | `releases`, `hardware_requirements` | Yes | R1 and R7 |
| `games` | The abstract game | Core | `profiles` | Yes | Core concept |
| `releases` | A qualifying physical edition | Core | `game_platforms`, `region_codes`, `profiles` | Yes | Core concept |
| `collection_items` | An owned physical game | Core | `profiles`, `releases` | Yes | Core concept, with privacy and Q9 status |
| `collection_item_private` | Owner-only purchase data | Core | `collection_items` | Yes | Purchase data can't be added safely later on the public table |
| `shelves` | User-arranged groups | Core | `profiles` | Yes | Virtual shelves are the default collection view |
| `shelf_items` | Item-to-shelf references | Core | `shelves`, `collection_items` | Yes | Shelves don't work without it |
| `game_platforms` | Physical game and platform pairing | Supporting | `games`, `platforms`, `profiles` | Yes | Composite key on `releases` depends on it |
| `region_codes` | Controlled vocabulary | Supporting | None | Yes | Foreign key on `releases` |
| `markets` | Countries and territories | Supporting | None | Yes | Needed by D7 |
| `release_markets` | Distribution of a Release | Supporting | `releases`, `markets` | Yes | Needed by D7 from the first catalog entry |
| `release_components` | Materials an edition included | Supporting | `releases` | Yes | Small, and part of edition identity |
| `collection_item_components` | Materials a copy has | Supporting | `collection_items` | Yes | Completeness tracking under Q12 |
| `game_relations` | Remakes, remasters and compilations | Supporting | `games` | Yes | D6 requires explicit links as records are approved |
| `catalog_change_requests` | Submission review queue | Supporting | `profiles`, `games`, `releases`, `platforms` | Yes | D5 needs it as soon as users can submit |
| `staff_roles` | Staff authorization | Supporting | `profiles` | Yes | Approval is restricted to staff |
| `handle_holds` | Reserved and released handles | Supporting | None | Yes | Handle rules need a store no client can reach. In `private` |
| `private.audit_events` | Audit log | Supporting | None, by design | Yes | Staff functions write to it (M4). A report reference is added with `reports` |
| `follows` | Accepted follows | Supporting | `profiles` | Yes | The visibility policies under D1 depend on it, and retrofitting means rewriting them |
| `blocked_users` | Blocks | Supporting | `profiles` | Yes | Same reason |
| `notifications` | User notices | Supporting | `profiles` | Yes | Q9 and D5 must notify owners. Post, comment and conversation columns are added with those tables |
| `catalog_images` | Image provenance | Supporting | `games`, `releases`, `profiles` | No | Blocked by D15. `provider_code` is added with providers |
| `wantlist_items` | Wanted games | Later | `profiles`, `releases`, `games`, `platforms` | No | Self-contained, and first to follow |
| `user_favorite_games` | Favorites | Later | `profiles`, `games` | No | Profile polish |
| `genres` | Genre vocabulary | Later | None | No | Browsing only |
| `game_genres` | Game to genre | Later | `games`, `genres` | No | Browsing only |
| `franchises` | Franchise vocabulary | Later | None | No | Browsing only |
| `game_franchises` | Game to franchise | Later | `games`, `franchises` | No | Browsing only |
| `posts` | Feed content | Later | `profiles`, `games`, `releases`, `collection_items`, `shelves`, `user_achievements` | No | Next major phase. The Home Feed stays on seed data until then |
| `post_images` | Post images | Later | `posts` | No | With posts |
| `comments` | Post comments | Later | `posts`, `profiles` | No | With posts |
| `likes` | Likes | Later | `posts`, `comments`, `profiles` | No | With posts |
| `bookmarks` | Saved posts | Later | `posts`, `profiles` | No | With posts |
| `reviews` | Scored reviews | Later | `posts`, `games`, `releases` | No | Depends on posts |
| `achievements` | Achievement definitions | Later | None | No | With posts |
| `user_achievements` | Awarded achievements | Later | `achievements`, `profiles` | No | With posts |
| `reports` | User reports | Later | `profiles`, `posts`, `comments`, `messages`, `shelves`, `collection_items` | No | **Required before public launch**, with targets added as their tables arrive |
| `conversations` | Conversations | Later | `profiles` | No | Blocked by D16 |
| `conversation_members` | Membership | Later | `conversations`, `profiles` | No | With messaging |
| `messages` | Messages | Later | `conversations`, `profiles` | No | With messaging |
| `external_providers` | Provider registry | Later | None | No | Blocked by D14 |
| `external_references` | Links to provider IDs | Later | `external_providers`, `games`, `releases`, `platforms` | No | Blocked by D14 |
| `provider_records` | Raw provider data | Later | `external_providers` | No | Blocked by D14 |
| `catalog_field_locks` | Protects corrections from sync | Later | `games`, `releases`, `platforms`, `profiles` | No | Only matters with providers |

That's 9 Core, 20 Supporting and 22 Later. **The first phase has 28 tables**: all Core, and all Supporting except `catalog_images`.

### First phase migration sequence

Each step ships its grants, RLS policies, constraints and tests together, so no table ever exists without its security. Each depends only on earlier steps.

| Step | Contents | Why here |
| --- | --- | --- |
| **M0 Foundation** (done) | Extensions, `private` schema, enum types, timestamp trigger, CI schema guards | Everything uses these |
| **M1 Reference data** (done) | `region_codes`, `markets`, `platforms`, `platform_names`, `media_formats`, `platform_media_formats`, `hardware_requirements`, seeded | No dependencies, public read only |
| **M2 Identity** (done) | `profiles`, `user_preferences`, `staff_roles`, `private.handle_holds`, sign-up trigger, role helpers, handle claim, `avatars` bucket | Everything is owned by a profile |
| **M3 Authorization graph** (done) | `follows`, `blocked_users`, visibility helpers, controlled functions, block-aware profile cards | Later policies call these |
| **M4 Audit and notices** (done) | `private.audit_events`, audited staff functions, a minimal `notifications` | Staff functions write to both |
| **M5 Catalog** (done: M5a to M5c. The SNES import pilot waits for provider clearance) | `games`, `game_platforms`, `game_relations`, `releases`, `release_markets`, `release_components`, `release_hardware_requirements`, the `requirement_level` enum, `game_media` on `component_kind`, read helpers | Needs reference data and profiles |
| **M6 Collection** (done) | `collection_items`, `collection_item_private`, `collection_item_components`, and the collection functions ([ADR-049](#adr-049-collections-are-owner-only-copies-added-idempotently)). Shelves are deferred (D3) | Needs the catalog and visibility helpers |
| **M7 Catalog workflow** (done: M7a to M7b-2c) | M7a: user submissions of missing games and releases (`catalog_change_requests`, `submit_game`, `submit_release`, `my_catalog_submissions`), usable at once by the submitter. M7b: editor review, request changes, reject, merge, exclude, reverse and publish, and an owner's relink of a copy | Exclusion and merge change collection items, so they follow M6. Submitting what the catalog lacks is a permanent product requirement (D5) |
| **M8 Superadmin Foundation** (done) | The Owner record and its protections, live MFA for staff and factor maturity, the staff authority matrix, ownership transfer and recovery, the unified `/admin` and Settings → Security. See [ADR-055](#adr-055-the-owner-is-a-protected-record-its-authority-needs-mature-mfa-and-recovery-is-an-audited-operator-procedure) | Staff work needs a protected Owner and verified staff first |
| **M9 Internationalization** (cancelled) | Not built. The application is English-only ([M10 decision D1](#m10-decisions-the-admin-panel-expansion)) | |
| **M10 Admin panel expansion** (built: M10a to M10e and the integration review, before the pull request) | M10a foundations and the overview's counts ([ADR-057](#adr-057-the-admin-overview-shows-role-scoped-bounded-counts-decided-in-the-database)). M10b catalog search, record pages and history ([ADR-058](#adr-058-catalog-history-is-an-allow-listed-view-of-the-audit-log)). M10c catalog editing, creator provenance and no self-review ([ADR-059](#adr-059-a-records-creator-is-kept-privately-and-never-reviews-it)). M10d read-only reference data, import monitoring and the system view ([ADR-060](#adr-060-imports-and-the-system-are-read-only-views-for-administrators-and-reference-data-is-the-public-tables)). M10e account search and summaries, the allow-listed audit log and the staff overview ([ADR-061](#adr-061-accounts-audit-and-staff-are-allow-listed-reads-over-the-m8-functions)) | Staff tools before the collector-facing milestones |

Later groups, in order:

| Step | Contents | Blocked by |
| --- | --- | --- |
| **L1 Collection extras** | `wantlist_items`, `user_favorite_games`, `genres`, `game_genres`, `franchises`, `game_franchises` | Nothing |
| **L2 Images** | `catalog_images`, storage buckets | D15 |
| **L3 Social** | `achievements`, `user_achievements`, `posts`, `post_images`, `comments`, `likes`, `bookmarks`, `reviews`, notification columns | Nothing |
| **L4 Reporting** | `reports`, a report reference on `private.audit_events` | L3. Needed before public launch |
| **L5 Messaging** | `conversations`, `conversation_members`, `messages` | D11, D16 |
| **L6 Providers** | `external_providers`, `external_references`, `provider_records`, `catalog_field_locks`, `catalog_images.provider_code` | D14 |

After M10, the product owner plans the collector-facing milestones: Collection Shelves, Game Details (with genres and franchises), Wishlist and Discovery. They take over the shelves and most of L1.

Shelf photos need a storage bucket separately, using the upload rules in [security-rls.md](security-rls.md#storage). Avatars are part of M2, and described in [Avatar storage](security-rls.md#avatar-storage).

### Before implementation

Results on the local stack, with CLI 3.0.0. All need repeating on a hosted project when one exists.

| Check | Status |
| --- | --- |
| PostgreSQL version and extensions | **17.11.** `citext`, `pg_trgm` and `pgtap` are available |
| UUID generation | `private.uuid_v7()` tested. No built-in `uuidv7()` |
| Grants and RLS behavior | **Differed from the design's assumption.** New tables were fully exposed. M0 corrects this, and tests enforce it |
| Migration dependencies | Every migration, M0 to M10e and the M10 integration review, applies in order to an empty database: `npm run db:verify` starts from a fresh reset |
| Secret handling | `npm run secrets:check`, `secrets:bundle`, and a pre-commit hook. CI runs the secret scan, its tests, typecheck, lint and the build on pull requests to `main`; the database, HTTP and browser suites run locally |
| Reproducible workflow | `npm run db:verify` |

**Gates that must be met along the way:**

| Before | Required |
| --- | --- |
| Catalog approval workflows open (M7 in use) | Written editorial eligibility guidelines (A3) |
| Real user data is processed | Retention policy (A2, D10, M4-D10), including catalog submissions, review history and audit rows; minimum age (D12); Frankfurt legal review (D13). See [Legal and age blockers](security-rls.md#legal-and-age-blockers) |
| Public authentication opens | All of [Blockers before public authentication](security-rls.md#blockers-before-public-authentication), and [Requirements before any hosted registration](security-rls.md#requirements-before-any-hosted-registration) |
| Public launch | Reporting (L4), including impersonation reporting and moderation, because lookalike handles may coexist. Rate limiting, and a security review of all policies |

### First implementation step

**M0 Foundation, on the local stack only.** No hosted project is needed.

1. Create a `phase-2b-m0-foundation` branch from `phase-2-architecture`.
2. Add the Supabase CLI as a pinned dev dependency, and initialize `supabase/`.
3. Start the local stack, and run the environment checks above. **If the results contradict this design, stop and report before writing any migration.**
4. Write one migration for: `private` schema, required extensions, enum types, the `updated_at` trigger function and `private.uuid_v7()`.
5. Add the test runner, with schema guards that fail if a `public` table lacks RLS, if `anon` holds an unapproved grant, or if a `SECURITY DEFINER` function has no fixed `search_path`.
6. Add one reset, migrate and test command, and document it in the README.

M0 creates no application tables and changes no application code. It stops there for review before M1.

**Deviation.** `pgtap` isn't installed by the migration. The CLI installs it for a test run and removes it afterwards, so test tooling never exists outside tests. The migration installs `citext` and `pg_trgm`.

### Trade-offs of this sequence

- **The social feed comes after collections.** The Home Feed stays on seed data through the first phase. Collections are the foundation that posts reference, so this order avoids rework, although the product is social-first.
- **No reporting in the first phase.** That's acceptable only before public launch, and L4 has to ship before real users arrive.
- **No images in the first phase.** The catalog shows placeholders until D15 is settled, so the first version won't look like the finished product.

## Suggested next steps

1. The M10 pull request and merge, each approved separately, after the integration review ([ADR-062](#adr-062-the-m10-integration-review-retires-the-raw-admin-reads-and-withholds-staff-reasons-from-moderators)).
2. After M10, the collector-facing milestones the product owner plans: Collection Shelves, Game Details, Wishlist and Discovery.
3. Create the Supabase project in Frankfurt when authorized, check the items in [security-rls.md](security-rls.md#to-verify-when-creating-the-project), and meet the [production launch prerequisites](security-rls.md#production-launch-prerequisites-m8).
4. Sign-in and server sessions are connected locally (M6a, [ADR-048](#adr-048-web-sessions-are-handled-only-on-the-server)). Sign-up and password reset wait for the public-authentication blockers.
5. Settle the gates above: guidelines before catalog approval, retention, D12 and legal review before real user data, and D15 before catalog art.
6. The SNES import pilot waits for each provider's clearance and the product owner's approval. M10 adds no importing ([M10 decision D8](#m10-decisions-the-admin-panel-expansion)).
