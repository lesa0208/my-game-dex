# Database schema

**Status:** Approved design, including the decisions on D1 to D9, Q1 to Q12, A1 to A3, P1 to P10, R1 to R8 and D13, and the strict physical-only scope. M0 and M1 are implemented on the local stack, in `supabase/migrations/`. The rest is design, and these aren't migrations.

This is the table-by-table reference for My Game Dex on Supabase and PostgreSQL.

| Document | Covers |
| --- | --- |
| This document | Every table: columns, keys, indexes, timestamps |
| [relationships.md](relationships.md) | ER diagrams, delete behavior, how the domains connect |
| [security-rls.md](security-rls.md) | Grants, Row Level Security, storage, server-side authorization |
| [architecture-decisions.md](architecture-decisions.md) | Why the design is this way, trade-offs, decisions awaiting approval |

## Product scope

**My Game Dex catalogs, manages, showcases and discusses physical video game editions and physical game collections.** This is a permanent product requirement, not a launch limitation. See [ADR-025](architecture-decisions.md#adr-025-the-product-is-permanently-physical-only).

**The test for a Release:** the physical medium contains actual game data. A box alone doesn't qualify, and neither does a card that only authorizes a download.

**The test for a Collection Item:** the user possesses the physical game medium. A physical game without its box is a valid item, and a box without the game is not. A factory-sealed copy qualifies on its declared edition, so the user doesn't have to open it.

| In scope | Out of scope, permanently |
| --- | --- |
| Cartridges, CD, DVD, Blu-ray, game cards that contain the game, and other genuine physical media containing the game | Download codes in boxes, and boxed digital download products |
| Original box, manual, inserts, maps, artwork and other original materials, as **components of a physical edition** | Game-Key Cards that only authorize downloading a game |
| | Digital-only editions, digital copies and account-bound entitlements |
| | Streaming and cloud gaming products |
| | Digital licenses and access keys |
| | Discs or cards containing only an installer, launcher or access key, or no meaningful game data |
| | Empty boxes, and manuals, inserts, maps or artwork without the game |
| | Standalone consoles, arcade boards and hardware accessories |

No table, column, enum value, filter or workflow in this design represents a digital product. Excluded products are kept out by the catalog review workflow, because a database can't inspect what a card or disc contains. See [relationships.md](relationships.md#submission-and-approval-workflow).

The three core concepts stay separate:

| Concept | Meaning |
| --- | --- |
| **Game** | The abstract video game itself |
| **Release** | A specific physical edition of a game: platform, region code, markets, physical format, packaging and other identifying characteristics |
| **Collection Item** | The actual physical copy owned by a user: condition, completeness, ownership details and personal notes |

## Table inventory

The design has 51 tables: the 26 requested and 25 supporting tables. Each supporting table exists because a requirement can't be met safely without it.

| Domain | Requested | Supporting |
| --- | --- | --- |
| User system | `profiles`, `user_preferences`, `user_favorite_games`, `follows`, `blocked_users` | `staff_roles`, `handle_holds` |
| Gaming catalog | `platforms`, `games`, `game_platforms`, `releases`, `genres`, `franchises` | `region_codes`, `markets`, `platform_names`, `media_formats`, `platform_media_formats`, `hardware_requirements`, `release_markets`, `release_components`, `release_hardware_requirements`, `game_relations`, `game_genres`, `game_franchises`, `catalog_images`, `catalog_change_requests` |
| Collection system | `collection_items`, `shelves`, `shelf_items`, `wantlist_items` | `collection_item_private`, `collection_item_components` |
| Social system | `posts`, `post_images`, `comments`, `likes`, `bookmarks`, `reviews`, `notifications` | `achievements`, `user_achievements` |
| Messaging | `conversations`, `conversation_members`, `messages` | None |
| Moderation | `reports` | `private.audit_events` (M4) |
| Metadata providers | None | `external_providers`, `external_references`, `provider_records`, `catalog_field_locks` |

Why each supporting table is needed:

| Table | Reason |
| --- | --- |
| `region_codes` | A controlled vocabulary for the collector-facing regional classification of a Release |
| `markets`, `release_markets` | One physical release can be distributed across several countries or territories, recorded independently of its region code |
| `platform_names` | Regional names and common aliases, stored apart from a platform's stable identity |
| `media_formats`, `platform_media_formats` | Separates a general media category from the specific physical format, and enforces valid platform and format pairs |
| `hardware_requirements`, `release_hardware_requirements` | Some physical releases need, or don't work on, a particular revision or add-on, without creating platforms or a hardware catalog |
| `release_components` | Inserts, maps, artwork and other original materials that came with an edition |
| `collection_item_components` | Which of those materials a user's copy has, and their condition |
| `game_relations` | Explicit links between originals, remakes and remasters, and between compilations and the games they contain |
| `game_genres`, `game_franchises` | A game can have several genres and belong to several franchises |
| `catalog_images` | Every image needs a recorded source and license status |
| `catalog_change_requests` | User submissions and corrections need a moderation workflow and history |
| `collection_item_private` | RLS can't hide individual columns, so private purchase data needs its own table ([ADR-003](architecture-decisions.md#adr-003-private-purchase-data-lives-in-its-own-table)) |
| `achievements`, `user_achievements` | Phase 1 has an Achievement post type, and users must not be able to award themselves one |
| `staff_roles` | Staff status must not live anywhere a user can edit |
| `handle_holds` | Reserved names and released handles must be enforced on the server, where no client can read or change them |
| `private.audit_events` | Staff actions need an audit trail that no client can read or change |
| `external_providers`, `external_references`, `provider_records`, `catalog_field_locks` | Metadata provider adapters, with the internal catalog as the source of truth |

## Conventions

**Hosting.** The proposed initial Supabase region is Central EU (Frankfurt), AWS `eu-central-1` (D13). The project hasn't been created, and this isn't a compliance claim. See [security-rls.md](security-rls.md#data-region-and-legal-review).

**Schemas.** Application tables live in `public`. Helper functions and `provider_records` live in `private`, which isn't exposed through the Data API.

**Primary keys.** `uuid` by default. High-volume, time-ordered tables use UUIDv7 for better index locality; see [ADR-007](architecture-decisions.md#adr-007-uuid-strategy). Junction tables use a composite key of their foreign keys. `regions`, `achievements` and `external_providers` use a stable text code.

**Timestamps.** All are `timestamptz` in UTC. `created_at` defaults to `now()`. `updated_at` is set by a trigger, so clients can't forge it. Append-only tables have no `updated_at`.

**Text.** `text` with a `CHECK` on length, never `varchar(n)`. Limits live in the database because a client can call the Data API directly and skip application validation.

**Pagination.** Lists use keyset pagination on `(created_at, id)` or `id`, never `OFFSET`. Indexes below are ordered to support it.

**Foreign key indexes.** PostgreSQL doesn't index foreign keys automatically. Every foreign key below has an index, either listed or as the leading column of a key.

**Soft delete.** Only `posts`, `comments`, `messages` and `reviews` have `deleted_at`, because moderation needs the evidence. Everything else is hard-deleted.

**`staff_only` and `system` columns.** Neither gets a client update grant, so no user can write them directly. `system` columns are written by triggers and functions. `staff_only` columns are written by functions that check the caller's staff role and record an audit row. Staff have no direct write access either, because grants apply per role and staff use the same `authenticated` role as everyone else.

**Composite foreign keys with nullable columns.** PostgreSQL skips a composite foreign key if any of its columns is null. Where a key includes a nullable column whose partner could also be null, a `CHECK` closes the gap.

## Enumerated types

| Type | Values |
| --- | --- |
| `visibility_level` | `public`, `followers`, `private` |
| `follow_status` | `pending`, `accepted`, `rejected`, `cancelled` |
| `theme_preference` | `system`, `dark`, `light` |
| `message_permission` | `everyone`, `followers`, `nobody` |
| `staff_role` | `moderator`, `catalog_editor`, `admin` |
| `account_status` | `active`, `suspended`, `deactivated` |
| `catalog_status` | `unverified`, `under_review`, `published`, `rejected`, `excluded`, `merged` |
| `catalog_request_type` | `new_game`, `new_release`, `correction` |
| `catalog_review_status` | `open`, `in_review`, `approved`, `changes_requested`, `rejected`, `excluded`, `merged` |
| `date_precision` | `day`, `month`, `year`, `unknown` |
| `game_kind` | `game`, `compilation`, `expansion` |
| `platform_kind` | `console`, `handheld`, `hybrid`, `computer`, `other` |
| `media_category` | `cartridge`, `optical_disc`, `solid_state_card`, `magnetic_disk`, `magnetic_tape`. All physical. There's deliberately no `other` |
| `hardware_requirement_kind` | `revision`, `add_on`, `compatibility_mode` |
| `requirement_level` | `required`, `partial`, `not_compatible`, `compatible`. Added in M5 |
| `game_relation_type` | `remake_of`, `remaster_of`, `contains` |
| `component_kind` | `insert`, `map`, `artwork`, `other`, plus `game_media` for additional media pieces, added in M5. No value for a box or manual |
| `media_playability` | `playable_from_media`, `download_required`, `unknown` |
| `collection_record_status` | `active`, `invalid_preserved` |
| `edition_kind` | `standard`, `limited`, `collector`, `reprint`, `bundle`, `promotional`, `other` |
| `completeness` | `sealed`, `complete`, `incomplete`, `loose`. Every value includes the game medium |
| `condition_grade` | `mint`, `near_mint`, `very_good`, `good`, `fair`, `poor`, `not_included` |
| `post_kind` | `general`, `pickup`, `showcase`, `review`, `discussion`, `achievement` |
| `moderation_status` | `visible`, `hidden`, `removed` |
| `notification_type` | `follow`, `follow_request`, `follow_accepted`, `like`, `comment`, `reply`, `mention`, `message`, `achievement`, `moderation`, `catalog_submission`, `catalog_exclusion` |
| `conversation_kind` | `direct`, `group` |
| `member_role` | `member`, `admin` |
| `report_reason` | `spam`, `harassment`, `hate`, `sexual_content`, `violence`, `illegal`, `counterfeit`, `impersonation`, `other` |
| `report_status` | `open`, `in_review`, `resolved`, `dismissed` |
| `image_kind` | `cover_front`, `cover_back`, `spine`, `media`, `manual`, `screenshot`, `other` |
| `license_status` | `unreviewed`, `licensed`, `user_contributed`, `rejected` |
| `provider_record_status` | `fetched`, `matched`, `needs_review`, `promoted`, `ignored`, `failed` |

Types with attributes or frequent changes use lookup tables instead: region codes, markets, platforms, genres, and franchises.

`edition_kind = 'bundle'` means several physical games sold together. Bundles with a console are out of scope under D4.

---

## User system

### `profiles`

A user's account record. **Only the public card columns can be read by clients**: `id`, `handle`, `display_name`, `avatar_path`, `bio` and `country_code`. RLS works on rows, not columns, so column grants protect the rest. Owners read their own private columns through `public.get_my_account()`. Email stays in Supabase's `auth.users` and is never copied here.

| Column | Type | Null | Notes |
| --- | --- | --- | --- |
| `id` | `uuid` | No | Same value as `auth.users.id`. Public |
| `handle` | `text` | Yes | Lowercase `a-z`, `0-9` and `_`, 3 to 24 characters. Public. Null until claimed, and set only through `claim_handle()`, which accepts any case and stores lowercase |
| `display_name` | `text` | Yes | 1 to 50 characters. Unicode allowed, in NFKC form, with no control or bidirectional characters. Can't present as the platform. Public |
| `avatar_path` | `text` | Yes | Storage path, not a URL: `{id}/{random uuid}.webp`. Public. Set only by the server workflow |
| `bio` | `text` | Yes | Up to 500 characters. Public |
| `country_code` | `text` | Yes | References `markets`. Optional and user-provided. Public |
| `collection_visibility` | `visibility_level` | No | Default `private` (D2). Master switch for the whole collection. Owner only |
| `follow_approval_required` | `boolean` | No | Default `false`. Owner only |
| `allow_search_indexing` | `boolean` | No | Default `false` (D3). Whether this user's public pages may be indexed. Owner only |
| `account_status` | `account_status` | No | `staff_only`. Default `active`. Means no sanction applies, and doesn't by itself make an account active. See `private.is_active_user()` |
| `handle_changed_at` | `timestamptz` | Yes | `system`. Starts the 30-day change cooldown. Set exactly when `handle` is set |
| `handle_correction_until` | `timestamptz` | Yes | `system`. End of the one correction allowed after a first claim. Cleared when used. Owner only |

- **Primary key:** `id`
- **Foreign keys:** `id` → `auth.users(id)` on delete cascade; `country_code` → `markets(code)` on delete set null
- **Unique:** `handle`, by exact lowercase spelling
- **Indexes:** `country_code`; trigram GIN on `handle` and `display_name` for collector search
- **Timestamps:** `created_at`, `updated_at`
- **Relationships:** owns collection items, shelves, posts and most user content

`cover_path` isn't built: no approved feature uses it. Follower counts aren't stored. They're computed live by `public.get_profile_counts()`. See [Follower lists and counts](security-rls.md#follower-lists-and-counts).

### `user_preferences`

Private settings, one row per user, readable only by that user.

| Column | Type | Null | Notes |
| --- | --- | --- | --- |
| `user_id` | `uuid` | No | |
| `locale` | `text` | No | BCP 47 tag. Default `en` |
| `timezone` | `text` | Yes | IANA name |
| `theme` | `theme_preference` | No | Default `system` |
| `default_currency` | `text` | Yes | ISO 4217: three uppercase letters |
| `preferred_region_code` | `text` | Yes | Default for catalog browsing |
| `default_item_visibility` | `visibility_level` | No | Default `private` (D2) |
| `default_shelf_visibility` | `visibility_level` | No | Default `private` (D2) |
| `default_post_visibility` | `visibility_level` | No | Default `public`. Pre-fills the composer only |
| `message_permission` | `message_permission` | No | Default `followers` |
| `notification_settings` | `jsonb` | No | Per-type email and in-app toggles. Default `{}` |

- **Primary key:** `user_id`
- **Foreign keys:** `user_id` → `profiles(id)` on delete cascade; `preferred_region_code` → `region_codes(code)` on delete set null
- **Unique:** covered by the primary key
- **Indexes:** `preferred_region_code`
- **Timestamps:** `created_at`, `updated_at`

`jsonb` is acceptable here because this is read one user at a time and never queried across users.

### `user_favorite_games`

Favorites reference a **Game**, not a Release, since a favorite is about the game.

| Column | Type | Null | Notes |
| --- | --- | --- | --- |
| `user_id` | `uuid` | No | |
| `game_id` | `uuid` | No | |
| `position` | `smallint` | No | Display order, 1 to 10 |

- **Primary key:** `(user_id, game_id)`
- **Foreign keys:** `user_id` → `profiles(id)` on delete cascade; `game_id` → `games(id)` on delete restrict
- **Unique:** `(user_id, position)`, deferrable so two favorites can swap
- **Indexes:** `game_id`, for "most favorited"
- **Timestamps:** `created_at`
- **Constraints:** `CHECK (position BETWEEN 1 AND 10)` also caps the list at 10. Policy allows published games only

### `follows`

No client role has any access to this table. Everything goes through the functions in [Follow requests](security-rls.md#follow-requests). There's one row per ordered pair, ever, so repeated requests can't build up history.

| Column | Type | Null | Notes |
| --- | --- | --- | --- |
| `follower_id` | `uuid` | No | |
| `followee_id` | `uuid` | No | |
| `status` | `follow_status` | No | `system`. A trigger refuses any transition not in the state machine |
| `rerequest_after` | `timestamptz` | Yes | `system`. End of a rejection or removal cooldown. A retry never changes it |
| `requested_at` | `timestamptz` | No | `system`. Default `now()` |
| `accepted_at` | `timestamptz` | Yes | `system`. Set exactly when `status` is `accepted`. Orders follower lists |

- **Primary key:** `(follower_id, followee_id)`
- **Foreign keys:** both → `profiles(id)` on delete cascade
- **Unique:** covered by the primary key
- **Indexes:** partial on `(followee_id, accepted_at DESC, follower_id DESC)` and `(follower_id, accepted_at DESC, followee_id DESC)` where accepted, for lists and counts; `(followee_id, requested_at DESC, follower_id DESC)` where pending, for the owner's queue; `(follower_id, requested_at DESC, followee_id DESC)` where pending or rejected, for the requester's list and the request limit
- **Timestamps:** `created_at`, `updated_at`
- **Constraints:** `CHECK (follower_id <> followee_id)`; `CHECK ((status = 'accepted') = (accepted_at IS NOT NULL))`; `CHECK (status <> 'rejected' OR rerequest_after IS NOT NULL)`; `CHECK (status NOT IN ('pending', 'accepted') OR rerequest_after IS NULL)`

Only `accepted` follows grant access, and only while the follower's own account is active. See [ADR-005](architecture-decisions.md#adr-005-followers-only-means-accepted-followers).

### `blocked_users`

| Column | Type | Null | Notes |
| --- | --- | --- | --- |
| `blocker_id` | `uuid` | No | |
| `blocked_id` | `uuid` | No | |

- **Primary key:** `(blocker_id, blocked_id)`
- **Foreign keys:** both → `profiles(id)` on delete cascade
- **Indexes:** `(blocked_id, blocker_id)`, so blocks can be checked in both directions
- **Timestamps:** `created_at`
- **Constraints:** `CHECK (blocker_id <> blocked_id)`

No client role has any access to this table. Creating a block removes follows, requests and cooldowns in both directions through a trigger, and unblocking restores none of them. See [Blocks](security-rls.md#blocks).

### `staff_roles`

| Column | Type | Null | Notes |
| --- | --- | --- | --- |
| `user_id` | `uuid` | No | |
| `role` | `staff_role` | No | |
| `granted_by` | `uuid` | Yes | |

- **Primary key:** `(user_id, role)`
- **Foreign keys:** `user_id` → `profiles(id)` on delete cascade; `granted_by` → `profiles(id)` on delete set null
- **Indexes:** `granted_by`
- **Timestamps:** `created_at`

No API role can write to this table, including `service_role`. See [Assigning the first administrator](security-rls.md#assigning-the-first-administrator).

### `handle_holds`

Lives in the `private` schema, with no grants to any API role. Names that can't be claimed: reserved names, permanently, and released handles, for 30 days. Stores a string with no link to any person.

| Column | Type | Null | Notes |
| --- | --- | --- | --- |
| `handle` | `text` | No | The reserved or released name |
| `skeleton` | `text` | No | `system`. Generated by `private.handle_skeleton(handle)`. Compared for reserved names. Released handles compare by exact spelling |
| `kind` | `text` | No | `reserved` or `released` |
| `match` | `text` | No | `exact`, or `contains` for platform brand terms. Default `exact` |
| `expires_at` | `timestamptz` | Yes | Required for `released`, and null for `reserved` |

- **Primary key:** `handle`
- **Foreign keys:** None
- **Indexes:** `skeleton`; `expires_at` where set
- **Timestamps:** `created_at`
- **Constraints:** `CHECK ((kind = 'reserved') = (expires_at IS NULL))`; `CHECK (kind = 'reserved' OR match = 'exact')`

---

## Gaming catalog

### Region codes, markets and physical edition identity

These are three separate concepts, all attached to the platform-specific **Release** and never to the abstract Game:

| Concept | Answers | Stored in |
| --- | --- | --- |
| **Release region code** | How do collectors classify this physical release? | `releases.region_code`, one value |
| **Release markets** | Which countries or territories was this physical package distributed to? | `release_markets`, zero or more |
| **Edition and package identity** | Which exact physical product is this? | `releases`: edition, variant, packaging, languages, rating labels, product code, barcode, medium |

**A region code isn't a hardware region lock.** It classifies the physical release as collectors do. A platform having no lock doesn't make its releases `region-free`.

**No table maps a region code to countries.** A release's region code and its markets are recorded independently, with no constraint between them. Regional conventions differ by platform and generation, so a fixed mapping would be wrong for some releases. For the same reason, there's no region hierarchy: PAL isn't a parent of a fixed country list. See [ADR-002](architecture-decisions.md#adr-002-region-codes-and-markets-are-independent) and the [worked examples](relationships.md#physical-release-examples).

**Unknown stays unknown.** If the classification isn't known, the region code is `unknown`. If the markets aren't known, the release has no `release_markets` rows. Neither is guessed from the other. Markets record known distribution, so the absence of a country isn't proof the release wasn't sold there.

### `region_codes`

The controlled vocabulary, approved under D7:

| Code | Label | Use for |
| --- | --- | --- |
| `ntsc-uc` | NTSC-U/C | Releases collectors classify as North American |
| `ntsc-j` | NTSC-J | Releases collectors classify as Japanese |
| `ntsc-k` | NTSC-K | Releases collectors classify as South Korean |
| `ntsc-c` | NTSC-C | Releases collectors classify as Chinese |
| `pal` | PAL | The broad PAL classification. Specific countries are recorded as markets |
| `asia` | ASIA | Asian releases outside the codes above. Doesn't imply a single release across Asian markets |
| `latam` | LATAM | Latin American releases with their own physical edition |
| `pal-m` | PAL-M | Releases collectors classify as PAL-M, associated with Brazil |
| `pal-n` | PAL-N | Releases collectors classify as PAL-N, associated with Argentina, Paraguay and Uruguay |
| `region-free` | REGION-FREE | Only a physical release genuinely classified as region-free or worldwide (Q11) |
| `unknown` | UNKNOWN | Not known. Reviewers use this rather than guessing |

"Use for" is guidance for reviewers, not a rule about countries. Eleven values were judged sufficient. A generic `other` was left out because it would duplicate `unknown` and encourage imprecise data, and values such as `ntsc-asia` were left out because they'd imply a single universal release. A new value can be added through staff tooling, without a schema change.

| Column | Type | Null | Notes |
| --- | --- | --- | --- |
| `code` | `text` | No | |
| `label` | `text` | No | Shown to users |
| `description` | `text` | No | Guidance for reviewers |
| `position` | `smallint` | No | Display order |

- **Primary key:** `code`
- **Timestamps:** `created_at`, `updated_at`

### `markets`

Countries and territories, identified by ISO 3166-1 alpha-2 codes. M1 seeds the 249 officially assigned codes, with sources in [reference-data-sources.md](reference-data-sources.md). Withdrawn ISO codes can be added for historical markets, and user-assigned codes such as `XK` only if a release needs one. Groupings such as "Benelux" or "Nordics" aren't stored, so a release lists the actual countries.

| Column | Type | Null | Notes |
| --- | --- | --- | --- |
| `code` | `text` | No | For example `DE`, `AU`, `HK`. `CHECK (code ~ '^[A-Z]{2}$')` |
| `name` | `text` | No | |

- **Primary key:** `code`
- **Timestamps:** `created_at`, `updated_at`

Phase 1 values map as `NA` to `ntsc-uc`, `EU` to `pal` and `JP` to `ntsc-j`.

### `platforms`

A software platform, not collectible hardware. **Identity is the slug, which can't change.** Regional names go in `platform_names`, and hardware revisions don't create rows. Add-ons with their own software library, such as Mega-CD, are separate platforms with `base_platform_id` set. M1 seeds 58.

| Column | Type | Null | Notes |
| --- | --- | --- | --- |
| `id` | `uuid` | No | |
| `slug` | `text` | No | For example `mega-drive`. A trigger blocks changes |
| `name` | `text` | No | Canonical name. Can change without affecting identity |
| `short_name` | `text` | No | Matches `Platform.shortName` |
| `manufacturer` | `text` | Yes | The platform owner or primary brand, not a contract assembler |
| `family` | `text` | No | Product line, for browsing |
| `kind` | `platform_kind` | No | |
| `base_platform_id` | `uuid` | Yes | Set for add-ons. A trigger blocks chains of add-ons |
| `released_year` | `smallint` | Yes | Earliest release anywhere. Null if uncertain |
| `notes` | `text` | Yes | Public. Records uncertainty and physical differences |

- **Primary key:** `id`
- **Foreign keys:** `base_platform_id` → `platforms(id)` on delete restrict
- **Unique:** `slug`, `name`
- **Indexes:** `(family, name)`; `base_platform_id` where not null; trigram GIN on `name`
- **Timestamps:** `created_at`, `updated_at`
- **Constraints:** `CHECK (base_platform_id IS DISTINCT FROM id)`

Backward compatibility has no table. A PlayStation disc played on a PlayStation 2 stays one PlayStation Release.

### `platform_names`

Official regional names and common collector aliases. Clones, codenames and unrelated hardware models are excluded. **A shared name never implies that hardware or media are interchangeable**: Famicom and NES cartridges, for example, have different pin counts.

| Column | Type | Null | Notes |
| --- | --- | --- | --- |
| `platform_id` | `uuid` | No | |
| `name` | `text` | No | |
| `region_code` | `text` | Yes | Where this name applies. Null means a general alias. Describes naming only, and never determines a Release's region code |

- **Primary key:** none. Identity is the unique constraint
- **Foreign keys:** `platform_id` → `platforms(id)` on delete cascade; `region_code` → `region_codes(code)` on delete restrict
- **Unique:** `NULLS NOT DISTINCT (platform_id, name, region_code)`
- **Indexes:** `region_code` where not null; trigram GIN on `name`
- **Timestamps:** `created_at`, `updated_at`

### `media_formats`

The controlled list of genuine physical game media. A category is general, and a format is specific. **A specific row exists only when collectors or manufacturers name that format.** Otherwise the generic row applies, and the platform says the rest. Staff can add a format without a schema change. M1 seeds 24.

| Column | Type | Null | Notes |
| --- | --- | --- | --- |
| `code` | `text` | No | For example `hucard`, `gd-rom`, `wii-u-optical-disc` |
| `category` | `media_category` | No | |
| `name` | `text` | No | |
| `description` | `text` | Yes | |
| `position` | `smallint` | No | Display order |

- **Primary key:** `code`
- **Unique:** `name`
- **Indexes:** `(category, position)`
- **Timestamps:** `created_at`, `updated_at`
- **Constraints:** a `CHECK` rejects codes and names suggesting a digital product, as a backstop. Eligibility is still an editorial decision, because a Game-Key Card looks like a game card

Later computer and PC batches add rows such as compact cassette and 3.5-inch floppy disk, with no schema change. Tests confirm this.

### `platform_media_formats`

Which formats a platform's physical games use. M5 requires a Release's platform and format to appear here, through a composite foreign key.

| Column | Type | Null | Notes |
| --- | --- | --- | --- |
| `platform_id` | `uuid` | No | |
| `media_format_code` | `text` | No | |

- **Primary key:** `(platform_id, media_format_code)`
- **Foreign keys:** `platform_id` → `platforms(id)` on delete cascade; `media_format_code` → `media_formats(code)` on delete restrict
- **Indexes:** `media_format_code`
- **Timestamps:** `created_at`

### `hardware_requirements`

Definitions of capabilities a physical release can need or be classified by. **These aren't hardware anyone owns:** nothing connects them to collections, and a row is added only when a release needs it. M1 seeds 11.

| Column | Type | Null | Notes |
| --- | --- | --- | --- |
| `code` | `text` | No | For example `new-3ds-family`, `n64-expansion-pak`, `gb-dual-mode` |
| `platform_id` | `uuid` | No | The platform it relates to |
| `label` | `text` | No | |
| `kind` | `hardware_requirement_kind` | No | |
| `description` | `text` | No | One capability can be met in several ways, such as Super CD-ROM² |

- **Primary key:** `code`
- **Foreign keys:** `platform_id` → `platforms(id)` on delete restrict
- **Unique:** `(platform_id, label)`
- **Timestamps:** `created_at`, `updated_at`

### `games`

The underlying video game, with no platform, region or edition.

| Column | Type | Null | Notes |
| --- | --- | --- | --- |
| `id` | `uuid` | No | |
| `slug` | `text` | Yes | Assigned on approval. Required when `published` |
| `title` | `text` | No | Canonical title |
| `sort_title` | `text` | No | "Legend of Zelda, The" |
| `kind` | `game_kind` | No | Default `game` |
| `summary` | `text` | Yes | |
| `first_release_date` | `date` | Yes | |
| `first_release_precision` | `date_precision` | No | Default `unknown` |
| `status` | `catalog_status` | No | `staff_only`. Default `unverified`. Published only with a qualifying physical edition |
| `merged_into_id` | `uuid` | Yes | `staff_only`. Set when `status = 'merged'` |
| `submitted_by` | `uuid` | Yes | `system`. Cleared on approval or merge |
| `search_vector` | `tsvector` | No | Generated from `title` |

- **Primary key:** `id`
- **Foreign keys:** `merged_into_id` → `games(id)` on delete restrict; `submitted_by` → `profiles(id)` on delete set null
- **Unique:** partial `slug` where not null
- **Indexes:** GIN on `search_vector` and trigram GIN on `title`, both where `status = 'published'`; `(status, sort_title)`; `merged_into_id` where not null; `submitted_by` where not null
- **Timestamps:** `created_at`, `updated_at`
- **Constraints:**
  - `CHECK ((status = 'merged') = (merged_into_id IS NOT NULL))`
  - `CHECK (status <> 'published' OR slug IS NOT NULL)`
  - `CHECK (status IN ('unverified', 'under_review', 'rejected', 'excluded') OR submitted_by IS NULL)`

**A digital-only game isn't cataloged.** The approval function publishes a game only if it has at least one published physical Release, or is contained in a published compilation that has one. A game that exists only digitally has no record here.

**Identity rules**, from D6 and Q2: ports and straight re-releases share a game. Remakes are separate games. Substantially rebuilt or materially altered remasters may be separate games, decided by a catalog editor rather than by marketing terminology. Compilations have their own record and explicit links to the games they contain. The rules and examples are in [ADR-026](architecture-decisions.md#adr-026-game-classification-is-a-manual-decision-recorded-as-relationships).

### `game_platforms`

Which platforms a game has physical releases on. It records only physical availability and never implies digital availability. Each row exists because a Release needs it, or was submitted with one.

| Column | Type | Null | Notes |
| --- | --- | --- | --- |
| `game_id` | `uuid` | No | |
| `platform_id` | `uuid` | No | |
| `status` | `catalog_status` | No | `staff_only`. Default `unverified` |
| `submitted_by` | `uuid` | Yes | `system`. Cleared on approval |

A submission can create a pairing that isn't in the catalog yet, so this table needs its own status. Otherwise an unverified submission would add to the public catalog through this table.

- **Primary key:** `(game_id, platform_id)`
- **Foreign keys:** `game_id` → `games(id)` on delete cascade; `platform_id` → `platforms(id)` on delete restrict; `submitted_by` → `profiles(id)` on delete set null
- **Indexes:** `(platform_id, game_id)` where `status = 'published'`; `(game_id, status)`; `submitted_by` where not null
- **Constraints:** `CHECK (status IN ('unverified', 'under_review', 'rejected', 'excluded') OR submitted_by IS NULL)`
- **Timestamps:** `created_at`, `updated_at`

### `releases`

One specific physical edition: platform, region code, physical format, packaging and other identifying characteristics. Markets are in `release_markets`, and included materials in `release_components`. **Different physical editions, packaging, regions and print variants are separate Releases**, and a product whose medium holds no actual game data isn't a Release at all.

`media_playability` describes a qualifying release. It doesn't decide whether one qualifies, which is the editor's decision on publishing. `unknown` is a valid published value when an editor has confirmed the medium holds actual game data. If that itself is unclear, the record stays in review.

| Column | Type | Null | Notes |
| --- | --- | --- | --- |
| `id` | `uuid` | No | |
| `game_id` | `uuid` | No | |
| `platform_id` | `uuid` | No | |
| `region_code` | `text` | No | Collector-facing classification. `unknown` when not known |
| `edition_name` | `text` | No | Default `Standard`. "Greatest Hits", "Collector's Edition" |
| `edition_kind` | `edition_kind` | No | Default `standard` |
| `variant_name` | `text` | Yes | "Gold cartridge", "Black label", "German packaging". Distinguishes packages that would otherwise look identical |
| `product_code` | `text` | Yes | "SLUS-00594" |
| `barcode` | `text` | Yes | UPC or EAN. Not unique: reprints can reuse one |
| `local_title` | `text` | Yes | Title in this market when it differs, such as "Biohazard" |
| `publisher_name` | `text` | Yes | Plain text until `companies` exists |
| `media_format_code` | `text` | No | The primary format. Required: a Release is always on a physical medium |
| `media_count` | `smallint` | No | Default 1. Number of pieces of the primary format, such as 3 discs. Additional formats go in `release_components` |
| `media_playability` | `media_playability` | No | Default `unknown`. Whether the game plays from the medium, subject to normal installation, or needs additional downloads for essential gameplay (Q8). `staff_only` once published |
| `packaging` | `text` | Yes | "Big box", "Jewel case", "Steelbook" |
| `languages` | `text[]` | Yes | BCP 47 tags, as printed on the package |
| `rating_labels` | `text[]` | Yes | As printed, such as `USK 12` or `PEGI 16`. Often distinguishes packages |
| `release_date` | `date` | Yes | |
| `release_date_precision` | `date_precision` | No | Default `unknown` |
| `status` | `catalog_status` | No | `staff_only`. Default `unverified` |
| `merged_into_id` | `uuid` | Yes | `staff_only` |
| `submitted_by` | `uuid` | Yes | `system`. Cleared on approval or merge, so a public row never shows who owns a copy |
| `verified_at` | `timestamptz` | Yes | `staff_only` |

- **Primary key:** `id`
- **Foreign keys:**
  - `(game_id, platform_id)` → `game_platforms(game_id, platform_id)`, so a release can't exist for a pairing that isn't recorded
  - `(platform_id, media_format_code)` → `platform_media_formats(platform_id, media_format_code)`, so a release can't use a format its platform doesn't have
  - `region_code` → `region_codes(code)` on delete restrict
  - `merged_into_id` → `releases(id)` on delete restrict
  - `submitted_by` → `profiles(id)` on delete set null
- **Unique:**
  - `(id, game_id)`, so other tables can use a composite foreign key that keeps game and release consistent
  - Partial `NULLS NOT DISTINCT (game_id, platform_id, region_code, edition_name, variant_name, packaging, product_code)` where `status = 'published'`. Packaging is part of the identity under D6
  - Partial `NULLS NOT DISTINCT (submitted_by, game_id, platform_id, region_code, edition_name, variant_name, packaging, product_code)` where `status IN ('unverified', 'under_review')`, so one user can't submit the same release twice
- **Indexes:**
  - `(game_id, platform_id, region_code)`
  - `(platform_id, region_code, release_date DESC)`
  - `barcode` where not null, for scanning
  - `product_code` where not null
  - trigram GIN on `local_title` where not null
  - `(status, created_at)` where `status IN ('unverified', 'under_review')`, for the review queue
  - `merged_into_id` where not null
  - `submitted_by` where not null
- **Timestamps:** `created_at`, `updated_at`
- **Constraints:**
  - `CHECK ((status = 'merged') = (merged_into_id IS NOT NULL))`
  - `CHECK (status IN ('unverified', 'under_review', 'rejected', 'excluded') OR submitted_by IS NULL)`
  - A trigger rejects `published` unless its game and game-platform pairing are also `published`

The uniqueness rule deliberately doesn't span unverified records. If it did, a second user submitting the same release would get an error revealing that someone else had. Duplicates are resolved by review. The workflow is in [relationships.md](relationships.md#submission-and-approval-workflow).

The rule covers the columns that can be compared reliably. Two packages differing only in something else, such as rating label or language, must be given different `variant_name` values by the reviewer. Markets aren't part of a release's identity, so one package sold in several countries remains one Release.

### `release_markets`

The countries and territories a physical release is known to have been distributed to. Follows the visibility of its release, so an unverified release's markets stay hidden.

| Column | Type | Null | Notes |
| --- | --- | --- | --- |
| `release_id` | `uuid` | No | |
| `market_code` | `text` | No | |

- **Primary key:** `(release_id, market_code)`
- **Foreign keys:** `release_id` → `releases(id)` on delete cascade; `market_code` → `markets(code)` on delete restrict
- **Indexes:** `(market_code, release_id)`, for browsing by country
- **Timestamps:** `created_at`

### `release_components`

What a physical edition included beyond its primary media: inserts, maps, artwork, and additional game media. This describes an edition, and is never owned by anyone. The box, manual and primary medium are described on `releases` and tracked per copy on `collection_items`, so they aren't listed here. Components aren't standalone products and can't be a Release themselves.

**Multiple media in one edition (R6).** Several pieces of the same format need only `releases.media_count`. A genuinely mixed edition adds a row with `kind = 'game_media'` for each additional format, such as a bonus game disc packaged with a cartridge. Separately sold formats are separate Releases. See [relationships.md](relationships.md#multiple-media-in-one-physical-edition).

| Column | Type | Null | Notes |
| --- | --- | --- | --- |
| `id` | `uuid` | No | |
| `release_id` | `uuid` | No | |
| `kind` | `component_kind` | No | |
| `label` | `text` | No | "Fold-out world map" |
| `quantity` | `smallint` | No | Default 1 |
| `media_format_code` | `text` | Yes | Required when `kind = 'game_media'`, and otherwise null |
| `platform_id` | `uuid` | Yes | The platform that media piece is for. Required when `kind = 'game_media'`, and otherwise null |

- **Primary key:** `id`
- **Foreign keys:** `release_id` → `releases(id)` on delete cascade; `(platform_id, media_format_code)` → `platform_media_formats(platform_id, media_format_code)` on delete restrict
- **Unique:** `(release_id, kind, label)`
- **Indexes:** covered by the unique constraint; `(platform_id, media_format_code)` where not null
- **Timestamps:** `created_at`, `updated_at`
- **Constraints:** `CHECK ((kind = 'game_media') = (media_format_code IS NOT NULL))` and the same for `platform_id`

### `release_hardware_requirements`

Links a physical Release to a hardware requirement, at a level. This sits on the Release because requirements can differ by edition: Perfect Dark's requirement differs by region, for example. **No row means nothing is recorded, never "runs on everything".** Added in M5.

| Column | Type | Null | Notes |
| --- | --- | --- | --- |
| `release_id` | `uuid` | No | |
| `requirement_code` | `text` | No | |
| `level` | `requirement_level` | No | `required`, `partial`, `not_compatible`, or `compatible` for documented cross-compatibility |
| `note` | `text` | Yes | Why, for editors |

- **Primary key:** `(release_id, requirement_code)`
- **Foreign keys:** `release_id` → `releases(id)` on delete cascade; `requirement_code` → `hardware_requirements(code)` on delete restrict
- **Indexes:** `requirement_code`
- **Timestamps:** `created_at`, `updated_at`

### `genres`

| Column | Type | Null | Notes |
| --- | --- | --- | --- |
| `id` | `uuid` | No | |
| `slug` | `text` | No | |
| `name` | `text` | No | |

- **Primary key:** `id`
- **Unique:** `slug`, `name`
- **Timestamps:** `created_at`, `updated_at`

### `game_genres`

| Column | Type | Null | Notes |
| --- | --- | --- | --- |
| `game_id` | `uuid` | No | |
| `genre_id` | `uuid` | No | |

- **Primary key:** `(game_id, genre_id)`
- **Foreign keys:** `game_id` → `games(id)` on delete cascade; `genre_id` → `genres(id)` on delete restrict
- **Indexes:** `(genre_id, game_id)`
- **Timestamps:** `created_at`

### `franchises`

| Column | Type | Null | Notes |
| --- | --- | --- | --- |
| `id` | `uuid` | No | |
| `slug` | `text` | No | |
| `name` | `text` | No | |
| `description` | `text` | Yes | |

- **Primary key:** `id`
- **Unique:** `slug`
- **Indexes:** trigram GIN on `name`
- **Timestamps:** `created_at`, `updated_at`

### `game_franchises`

| Column | Type | Null | Notes |
| --- | --- | --- | --- |
| `game_id` | `uuid` | No | |
| `franchise_id` | `uuid` | No | |

- **Primary key:** `(game_id, franchise_id)`
- **Foreign keys:** `game_id` → `games(id)` on delete cascade; `franchise_id` → `franchises(id)` on delete restrict
- **Indexes:** `(franchise_id, game_id)`
- **Timestamps:** `created_at`

### `game_relations`

Explicit links between Game records, written only by catalog editors. Ports and re-releases have no row here because they're the same Game.

| Column | Type | Null | Notes |
| --- | --- | --- | --- |
| `source_game_id` | `uuid` | No | The remake, remaster or compilation |
| `target_game_id` | `uuid` | No | The original, or the game contained |
| `relation` | `game_relation_type` | No | |
| `position` | `smallint` | Yes | Order within a compilation |
| `note` | `text` | Yes | Why this classification was chosen |

- **Primary key:** `(source_game_id, target_game_id, relation)`
- **Foreign keys:** both → `games(id)` on delete cascade
- **Indexes:** `(target_game_id, relation)`
- **Timestamps:** `created_at`, `updated_at`
- **Constraints:** `CHECK (source_game_id <> target_game_id)`. A trigger requires the source of `contains` to have `kind = 'compilation'`

### `catalog_images`

Replaces the single `coverUrl` in the Phase 1 types, and records where each image came from and whether we may show it.

| Column | Type | Null | Notes |
| --- | --- | --- | --- |
| `id` | `uuid` | No | |
| `game_id` | `uuid` | Yes | Set this or `release_id` |
| `release_id` | `uuid` | Yes | Set this or `game_id` |
| `kind` | `image_kind` | No | |
| `storage_path` | `text` | No | Always our storage, never a hotlink |
| `width`, `height` | `integer` | Yes | |
| `is_primary` | `boolean` | No | Default `false` |
| `license_status` | `license_status` | No | `staff_only`. Default `unreviewed` |
| `attribution` | `text` | Yes | Shown where a license requires it |
| `provider_code` | `text` | Yes | Null when not from a provider |
| `bucket` | `text` | No | `catalog-submissions` until approved, then `catalog` |
| `uploaded_by` | `uuid` | Yes | `system`. Cleared on approval |

- **Primary key:** `id`
- **Foreign keys:** `game_id` → `games(id)` on delete cascade; `release_id` → `releases(id)` on delete cascade; `provider_code` → `external_providers(code)` on delete set null; `uploaded_by` → `profiles(id)` on delete set null
- **Unique:** partial unique `(release_id, kind)` where `is_primary` and `release_id` is not null; partial unique `(game_id, kind)` where `is_primary` and `game_id` is not null
- **Indexes:** `release_id`, `game_id`, `provider_code`, `uploaded_by`; `(license_status, created_at)` where `license_status = 'unreviewed'`
- **Timestamps:** `created_at`, `updated_at`
- **Constraints:** `CHECK (num_nonnulls(game_id, release_id) = 1)`

### `catalog_change_requests`

The moderation queue and permanent record for submissions and corrections. It holds who submitted what, so that link can be removed from public catalog rows. **Only staff read this table.** Submitters use a function that returns safe fields, because a read policy would also expose the reviewer's identity.

| Column | Type | Null | Notes |
| --- | --- | --- | --- |
| `id` | `uuid` | No | |
| `request_type` | `catalog_request_type` | No | |
| `submitted_by` | `uuid` | Yes | Null after the submitter's account is deleted |
| `game_id` | `uuid` | Yes | Target |
| `release_id` | `uuid` | Yes | Target |
| `platform_id` | `uuid` | Yes | Target of a correction |
| `proposed_changes` | `jsonb` | Yes | Field name to proposed value. Used by `correction` |
| `reason` | `text` | Yes | From the submitter |
| `status` | `catalog_review_status` | No | `staff_only`. Default `open` |
| `reviewer_note` | `text` | Yes | `staff_only`. Shown to the submitter |
| `merged_into_release_id` | `uuid` | Yes | `staff_only`. Set when marked a duplicate |
| `reviewed_by` | `uuid` | Yes | `staff_only` |
| `reviewed_at` | `timestamptz` | Yes | `staff_only` |

- **Primary key:** `id`
- **Foreign keys:** `submitted_by`, `reviewed_by` → `profiles(id)` on delete set null; `game_id` → `games(id)`, `release_id` → `releases(id)`, `platform_id` → `platforms(id)`, all on delete cascade; `merged_into_release_id` → `releases(id)` on delete set null
- **Indexes:** `(status, created_at)`; `(submitted_by, created_at DESC)`; `reviewed_by`; `game_id`; `release_id`; `platform_id`; `merged_into_release_id` where not null
- **Timestamps:** `created_at`, `updated_at`, `reviewed_at`
- **Constraints:** `CHECK (num_nonnulls(game_id, release_id, platform_id) >= 1)`

---

## Collection system

### `collection_items`

One actual physical game owned by one user. Owning two copies of a release means two rows. **The game medium is always part of a Collection Item**, so a box or manual alone can't be recorded. **Every column here is visible to anyone who can read the row.**

| Column | Type | Null | Notes |
| --- | --- | --- | --- |
| `id` | `uuid` (v7) | No | |
| `owner_id` | `uuid` | No | |
| `release_id` | `uuid` | No | On creation, a `published` release or the owner's own submission. Never an `excluded` one |
| `completeness` | `completeness` | No | |
| `overall_condition` | `condition_grade` | Yes | Null means not assessed |
| `box_condition` | `condition_grade` | Yes | `not_included` means there's no box |
| `media_condition` | `condition_grade` | Yes | Disc or cartridge |
| `manual_condition` | `condition_grade` | Yes | |
| `visibility` | `visibility_level` | No | Default `private` (D2) |
| `record_status` | `collection_record_status` | No | `system`. Default `active`. `invalid_preserved` when its release was excluded (Q9) |
| `invalidated_at` | `timestamptz` | Yes | `system`. Set with `invalid_preserved` |

- **Primary key:** `id`
- **Foreign keys:** `owner_id` → `profiles(id)` on delete cascade; `release_id` → `releases(id)` on delete restrict
- **Unique:** `(id, owner_id)`, the target for composite foreign keys. There's deliberately no unique `(owner_id, release_id)`
- **Indexes:**
  - `(owner_id, id DESC)` for collection browsing
  - `(owner_id, release_id)` where `record_status = 'active'`, for statistics
  - `(release_id)` where `record_status = 'invalid_preserved'`, for the resolution queue
  - `(owner_id, release_id)` for "do I already own this?"
  - `(owner_id, visibility, id DESC)` for public views
  - `(release_id, owner_id)` for "who owns this release"
- **Timestamps:** `created_at`, `updated_at`
- **Constraints:**
  - `CHECK (overall_condition IS DISTINCT FROM 'not_included')`
  - `completeness = 'loose'` requires `box_condition` and `manual_condition` to be null or `not_included`
  - `CHECK (media_condition IS DISTINCT FROM 'not_included')`. A Collection Item is a physical game, so it always includes the medium
  - `completeness = 'complete'` requires `box_condition` to not be `not_included`
  - `completeness = 'sealed'` requires `media_condition` and `manual_condition` to be null, because they can't be assessed without opening it
  - `CHECK ((record_status = 'invalid_preserved') = (invalidated_at IS NOT NULL))`
  - The insert and update policies check `release_id`, because foreign keys ignore RLS and could otherwise attach an item to another user's submission

What each `completeness` value means, with details in [relationships.md](relationships.md#collection-item-completeness-and-components):

| Value | Meaning | Counts as one owned game |
| --- | --- | --- |
| `loose` | The cartridge or disc only | Yes |
| `incomplete` | The game with some of its packaging, materials or media pieces, such as one disc of two | Yes |
| `complete` | Complete in Box (CIB) | Yes |
| `sealed` | Factory sealed, on the declared edition and condition | Yes |

**A counted copy** is a row with `record_status = 'active'` whose release is `published`. Under A1, only counted copies make up official owned-game statistics, through one shared function, and components never add to a count. Everything else is shown separately and only to its owner:

| Category | Rule | Counts as owned? | Shown to |
| --- | --- | --- | --- |
| **Owned** | `active`, release `published` | Yes | The owner. Others see the rows they can read |
| **Pending** | `active`, release `unverified` or `under_review` | No | The owner |
| **Not approved** | `active`, release `rejected` | No | The owner |
| **Invalid preserved** | `invalid_preserved` | No | The owner |

The categories are returned separately by a summary function that only ever describes the caller, so they can't be confused with one another.

Disposal history (sold, traded) is deferred. For now, deleting a row means the copy is gone.

### `collection_item_private`

The owner-only part of a collection item. Only the owner can read it, whatever the item's visibility. A row exists only when the owner has entered at least one of these values.

| Column | Type | Null | Notes |
| --- | --- | --- | --- |
| `item_id` | `uuid` | No | |
| `owner_id` | `uuid` | No | |
| `purchase_price` | `numeric(14,4)` | Yes | Handles currencies with 0 to 4 decimal places |
| `currency` | `char(3)` | Yes | ISO 4217 |
| `purchase_date` | `date` | Yes | |
| `personal_rating` | `numeric(3,1)` | Yes | 0.5 to 10 in half-point steps, matching `ReviewPost.score` |
| `notes` | `text` | Yes | Up to 5,000 characters |

- **Primary key:** `item_id`
- **Foreign keys:** `(item_id, owner_id)` → `collection_items(id, owner_id)` on delete cascade
- **Indexes:** `(owner_id, purchase_date DESC)` for spending views
- **Timestamps:** `created_at`, `updated_at`
- **Constraints:**
  - `CHECK ((purchase_price IS NULL) = (currency IS NULL))`
  - `CHECK (purchase_price >= 0)`
  - `CHECK (currency ~ '^[A-Z]{3}$')`
  - `CHECK (personal_rating BETWEEN 0.5 AND 10 AND personal_rating * 2 = floor(personal_rating * 2))`

### `collection_item_components`

Which original materials or additional media pieces this copy has, such as an insert, a map or "Disc 2", and their condition. **This table can't hold a standalone component:** `item_id` is required, a foreign key requires a real item, and deleting the item deletes its components. Readable only by those who can read the parent item, and the owner alone can write. Rows never count towards statistics.

| Column | Type | Null | Notes |
| --- | --- | --- | --- |
| `id` | `uuid` | No | |
| `item_id` | `uuid` | No | |
| `owner_id` | `uuid` | No | |
| `kind` | `component_kind` | No | |
| `label` | `text` | No | |
| `condition` | `condition_grade` | Yes | `not_included` means this copy is missing it |

- **Primary key:** `id`
- **Foreign keys:** `(item_id, owner_id)` → `collection_items(id, owner_id)` on delete cascade
- **Unique:** `(item_id, kind, label)`
- **Indexes:** covered by the unique constraint; `(owner_id, item_id)`
- **Timestamps:** `created_at`, `updated_at`

### `shelves`

| Column | Type | Null | Notes |
| --- | --- | --- | --- |
| `id` | `uuid` | No | |
| `owner_id` | `uuid` | No | |
| `name` | `text` | No | 1 to 80 characters |
| `description` | `text` | Yes | Up to 1,000 characters |
| `visibility` | `visibility_level` | No | Default `private` (D2) |
| `sort_rank` | `text COLLATE "C"` | No | Fractional index |

- **Primary key:** `id`
- **Foreign keys:** `owner_id` → `profiles(id)` on delete cascade
- **Unique:** `(id, owner_id)`; `(owner_id, lower(name))`
- **Indexes:** `(owner_id, sort_rank)`
- **Timestamps:** `created_at`, `updated_at`

### `shelf_items`

A reference to a collection item, never a copy of its data. One item can sit on several shelves. `owner_id` is included only so composite foreign keys can guarantee the shelf and the item share one owner.

| Column | Type | Null | Notes |
| --- | --- | --- | --- |
| `shelf_id` | `uuid` | No | |
| `collection_item_id` | `uuid` | No | |
| `owner_id` | `uuid` | No | |
| `sort_rank` | `text COLLATE "C"` | No | Fractional index |

- **Primary key:** `(shelf_id, collection_item_id)`
- **Foreign keys:** `(shelf_id, owner_id)` → `shelves(id, owner_id)` on delete cascade; `(collection_item_id, owner_id)` → `collection_items(id, owner_id)` on delete cascade
- **Indexes:** `(shelf_id, sort_rank)`; `(collection_item_id, owner_id)`; `(owner_id, shelf_id)`
- **Timestamps:** `created_at`, `updated_at`

### `wantlist_items`

A user can want one exact release, or a game on any platform or one platform.

| Column | Type | Null | Notes |
| --- | --- | --- | --- |
| `id` | `uuid` | No | |
| `owner_id` | `uuid` | No | |
| `release_id` | `uuid` | Yes | Exact release |
| `game_id` | `uuid` | Yes | Any release of this game |
| `platform_id` | `uuid` | Yes | Narrows `game_id` to one platform |
| `minimum_completeness` | `completeness` | Yes | |
| `priority` | `smallint` | No | 1 to 5. Default 3 |
| `visibility` | `visibility_level` | No | Default `private` (Q4). Independent of `collection_visibility`, so a wantlist can be public with a private collection |

- **Primary key:** `id`
- **Foreign keys:** `owner_id` → `profiles(id)` on delete cascade; `release_id` → `releases(id)`, `game_id` → `games(id)`, `platform_id` → `platforms(id)`, all on delete restrict
- **Unique:** partial unique `(owner_id, release_id)` where `release_id` is not null; `NULLS NOT DISTINCT (owner_id, game_id, platform_id)` where `game_id` is not null
- **Indexes:** `(owner_id, priority, created_at DESC)`; `release_id`; `(game_id, platform_id)`; `platform_id`
- **Timestamps:** `created_at`, `updated_at`
- **Constraints:** `CHECK (num_nonnulls(release_id, game_id) = 1)`; `CHECK (platform_id IS NULL OR game_id IS NOT NULL)`. Policy allows published games and releases only

There's deliberately no maximum price. On a publicly visible row it would show sellers what a buyer will pay. If needed later, it belongs in a private table like `collection_item_private`.

---

## Social system

### `posts`

Shared columns for all six post types. A `CHECK` enforces which reference columns each `kind` needs.

| Column | Type | Null | Notes |
| --- | --- | --- | --- |
| `id` | `uuid` (v7) | No | |
| `author_id` | `uuid` | No | |
| `kind` | `post_kind` | No | |
| `title` | `text` | Yes | Used by `discussion`. Up to 200 characters |
| `body` | `text` | Yes | Up to 5,000 characters. A review's text lives here |
| `visibility` | `visibility_level` | No | **No default (Q5).** The composer may preselect `public`, and every insert states the value, so an unspecified post fails rather than becoming public |
| `game_id` | `uuid` | Yes | Related game. Published only |
| `release_id` | `uuid` | Yes | Related release. Published only |
| `collection_item_id` | `uuid` | Yes | `pickup`: the copy. Set null if the copy is deleted |
| `subject_completeness` | `completeness` | Yes | `pickup`: what the author chose to disclose when posting |
| `shelf_id` | `uuid` | Yes | `showcase`: the shelf. Set null if the shelf is deleted |
| `user_achievement_id` | `uuid` | Yes | `achievement` |
| `like_count` | `integer` | No | `system`. Default 0 |
| `comment_count` | `integer` | No | `system`. Default 0 |
| `moderation_status` | `moderation_status` | No | `staff_only`. Default `visible` |
| `deleted_at` | `timestamptz` | Yes | |

- **Primary key:** `id`
- **Foreign keys:**
  - `author_id` → `profiles(id)` on delete cascade
  - `game_id` → `games(id)` on delete restrict
  - `(release_id, game_id)` → `releases(id, game_id)` on delete restrict
  - `(collection_item_id, author_id)` → `collection_items(id, owner_id)` on delete set null (`collection_item_id`)
  - `(shelf_id, author_id)` → `shelves(id, owner_id)` on delete set null (`shelf_id`)
  - `user_achievement_id` → `user_achievements(id)` on delete set null
- **Unique:** `(id, author_id)`
- **Indexes:**
  - `(author_id, id DESC)` where `deleted_at IS NULL`, for profiles and the Following feed
  - `id DESC` where public, visible and not deleted, for the Latest feed
  - `(game_id, id DESC)` where `game_id` is not null and not deleted
  - `(release_id, id DESC)` where `release_id` is not null and not deleted
  - `(collection_item_id, author_id)` where not null
  - `(shelf_id, author_id)` where not null
  - `user_achievement_id` where not null
  - `(moderation_status, id DESC)` where not `visible`
- **Timestamps:** `created_at`, `updated_at`, `deleted_at`
- **Constraints:** `CHECK (release_id IS NULL OR game_id IS NOT NULL)`. Without it, a null `game_id` makes PostgreSQL skip the composite foreign key, so `release_id` could point at nothing

How each kind maps to the Phase 1 types:

| `kind` | Required | Optional | Details come from |
| --- | --- | --- | --- |
| `general` | `body` | `release_id`, `game_id` | `post_images` |
| `pickup` | `release_id`, `game_id`, `subject_completeness` | `collection_item_id`, `body` | `releases` |
| `showcase` | `body` | `shelf_id` | `shelves`, `shelf_items`, `post_images` |
| `review` | `game_id`, `body` | `release_id` | `reviews` |
| `discussion` | `title`, `body` | `release_id`, `game_id` | |
| `achievement` | `user_achievement_id` | `release_id`, `game_id`, `body` | `achievements` |

`shelf_id` and `collection_item_id` are never required, because deleting the shelf or item later sets them to null and the post must survive that. The `CHECK` for each kind also rejects references that don't belong to it, such as `shelf_id` on a `pickup`.

### `post_images`

| Column | Type | Null | Notes |
| --- | --- | --- | --- |
| `id` | `uuid` | No | |
| `post_id` | `uuid` | No | |
| `bucket` | `text` | No | `post-media-public` or `post-media-private`, chosen from post visibility |
| `storage_path` | `text` | No | |
| `alt_text` | `text` | Yes | Up to 500 characters. Matches `PostImage.alt` |
| `width`, `height` | `integer` | Yes | |
| `position` | `smallint` | No | |

- **Primary key:** `id`
- **Foreign keys:** `post_id` → `posts(id)` on delete cascade
- **Unique:** `(post_id, position)`; `(bucket, storage_path)`
- **Indexes:** covered by the unique constraint on `(post_id, position)`
- **Timestamps:** `created_at`

### `comments`

| Column | Type | Null | Notes |
| --- | --- | --- | --- |
| `id` | `uuid` (v7) | No | |
| `post_id` | `uuid` | No | |
| `author_id` | `uuid` | Yes | Null after the author's account is deleted |
| `parent_id` | `uuid` | Yes | One level of replies is enforced by a trigger |
| `body` | `text` | No | 1 to 2,000 characters |
| `like_count` | `integer` | No | `system`. Default 0 |
| `moderation_status` | `moderation_status` | No | `staff_only`. Default `visible` |
| `deleted_at` | `timestamptz` | Yes | Replies stay; the comment shows as deleted |

- **Primary key:** `id`
- **Foreign keys:** `post_id` → `posts(id)` on delete cascade; `author_id` → `profiles(id)` on delete set null; `(parent_id, post_id)` → `comments(id, post_id)` on delete cascade
- **Unique:** `(id, post_id)`
- **Indexes:** `(post_id, id)`; `(parent_id, post_id)` where not null; `(author_id, id DESC)`
- **Timestamps:** `created_at`, `updated_at`, `deleted_at`

### `likes`

| Column | Type | Null | Notes |
| --- | --- | --- | --- |
| `id` | `uuid` (v7) | No | |
| `user_id` | `uuid` | No | |
| `post_id` | `uuid` | Yes | Set this or `comment_id` |
| `comment_id` | `uuid` | Yes | |

- **Primary key:** `id`
- **Foreign keys:** `user_id` → `profiles(id)`, `post_id` → `posts(id)`, `comment_id` → `comments(id)`, all on delete cascade
- **Unique:** partial unique `(user_id, post_id)` where `post_id` is not null; partial unique `(user_id, comment_id)` where `comment_id` is not null. These also answer "has the viewer liked this?"
- **Indexes:** `(post_id, id DESC)` where not null; `(comment_id, id DESC)` where not null
- **Timestamps:** `created_at`
- **Constraints:** `CHECK (num_nonnulls(post_id, comment_id) = 1)`

### `bookmarks`

Private to the user.

| Column | Type | Null | Notes |
| --- | --- | --- | --- |
| `user_id` | `uuid` | No | |
| `post_id` | `uuid` | No | |

- **Primary key:** `(user_id, post_id)`
- **Foreign keys:** `user_id` → `profiles(id)`, `post_id` → `posts(id)`, both on delete cascade
- **Indexes:** `(user_id, created_at DESC)`; `post_id`
- **Timestamps:** `created_at`

### `reviews`

A review is a post with extra structure. Its text is in `posts.body` and its likes and comments attach to the post, so nothing is stored twice.

| Column | Type | Null | Notes |
| --- | --- | --- | --- |
| `id` | `uuid` | No | |
| `post_id` | `uuid` | No | |
| `author_id` | `uuid` | No | |
| `game_id` | `uuid` | No | |
| `release_id` | `uuid` | Yes | Null means a review of the game in general |
| `title` | `text` | No | 1 to 150 characters |
| `score` | `numeric(3,1)` | No | 0.5 to 10 in half-point steps |
| `deleted_at` | `timestamptz` | Yes | Follows the post by trigger |

- **Primary key:** `id`
- **Foreign keys:** `(post_id, author_id)` → `posts(id, author_id)` on delete cascade; `game_id` → `games(id)` on delete restrict; `(release_id, game_id)` → `releases(id, game_id)` on delete restrict
- **Unique:** `post_id`; partial `NULLS NOT DISTINCT (author_id, game_id, release_id)` where `deleted_at IS NULL`, giving one active review per user per game or release
- **Indexes:** `(game_id, created_at DESC)` where not deleted; `(release_id, created_at DESC)` where not null; `(author_id, created_at DESC)`
- **Timestamps:** `created_at`, `updated_at`, `deleted_at`
- **Constraints:** same half-point check as `personal_rating`, approved as D8. Any active user may review a published game or release, and ownership isn't required (D9)

### `achievements`

Definitions, maintained by staff.

| Column | Type | Null | Notes |
| --- | --- | --- | --- |
| `code` | `text` | No | For example `century_shelf` |
| `title` | `text` | No | "Century Shelf" |
| `description` | `text` | No | "Cataloged 100 physical games" |
| `is_active` | `boolean` | No | Default `true` |

- **Primary key:** `code`
- **Timestamps:** `created_at`, `updated_at`

### `user_achievements`

Awarded only by the server, so an achievement can't be forged.

| Column | Type | Null | Notes |
| --- | --- | --- | --- |
| `id` | `uuid` | No | |
| `user_id` | `uuid` | No | |
| `achievement_code` | `text` | No | |
| `awarded_at` | `timestamptz` | No | |

- **Primary key:** `id`
- **Foreign keys:** `user_id` → `profiles(id)` on delete cascade; `achievement_code` → `achievements(code)` on delete restrict
- **Unique:** `(user_id, achievement_code)`
- **Indexes:** `(achievement_code, awarded_at DESC)`
- **Timestamps:** `awarded_at`

### `notifications`

Created only by triggers and privileged functions. Purged after 90 days, a period awaiting approval as part of [D10](architecture-decisions.md#decisions-requiring-product-owner-approval).

| Column | Type | Null | Notes |
| --- | --- | --- | --- |
| `id` | `uuid` (v7) | No | |
| `recipient_id` | `uuid` | No | |
| `actor_id` | `uuid` | Yes | Null for system notifications |
| `type` | `notification_type` | No | |
| `post_id` | `uuid` | Yes | |
| `comment_id` | `uuid` | Yes | |
| `conversation_id` | `uuid` | Yes | |
| `data` | `jsonb` | No | Render details only. Default `{}` |
| `read_at` | `timestamptz` | Yes | The one column a client may update |

- **Primary key:** `id`
- **Foreign keys:** `recipient_id` → `profiles(id)` on delete cascade; `actor_id` → `profiles(id)` on delete set null; `post_id` → `posts(id)`, `comment_id` → `comments(id)`, `conversation_id` → `conversations(id)`, all on delete cascade
- **Unique:** partial `NULLS NOT DISTINCT (recipient_id, actor_id, type, post_id, comment_id)` where `type IN ('like', 'follow')`, so repeatedly toggling a like can't spam someone
- **Indexes:** `(recipient_id, id DESC)`; `(recipient_id, id DESC)` where `read_at IS NULL`; `actor_id`; `post_id`; `comment_id`; `conversation_id`
- **Timestamps:** `created_at`, `read_at`

---

## Messaging

### `conversations`

| Column | Type | Null | Notes |
| --- | --- | --- | --- |
| `id` | `uuid` | No | |
| `kind` | `conversation_kind` | No | |
| `direct_key` | `text` | Yes | For `direct`: the two user IDs, sorted and joined |
| `title` | `text` | Yes | For `group` |
| `created_by` | `uuid` | Yes | |
| `last_message_at` | `timestamptz` | Yes | `system` |

- **Primary key:** `id`
- **Foreign keys:** `created_by` → `profiles(id)` on delete set null
- **Unique:** `direct_key`, so two people have one direct conversation
- **Indexes:** `created_by`
- **Timestamps:** `created_at`, `updated_at`
- **Constraints:** `CHECK ((kind = 'direct') = (direct_key IS NOT NULL))`

### `conversation_members`

| Column | Type | Null | Notes |
| --- | --- | --- | --- |
| `conversation_id` | `uuid` | No | |
| `user_id` | `uuid` | No | |
| `role` | `member_role` | No | `system`. Default `member` |
| `last_read_at` | `timestamptz` | Yes | Client may update |
| `muted_until` | `timestamptz` | Yes | Client may update |
| `left_at` | `timestamptz` | Yes | `system`. Set through a function |

- **Primary key:** `(conversation_id, user_id)`
- **Foreign keys:** `conversation_id` → `conversations(id)`, `user_id` → `profiles(id)`, both on delete cascade
- **Indexes:** `(user_id, conversation_id)` where `left_at IS NULL`, for the inbox
- **Timestamps:** `created_at` (joined), `updated_at`

### `messages`

| Column | Type | Null | Notes |
| --- | --- | --- | --- |
| `id` | `uuid` (v7) | No | |
| `conversation_id` | `uuid` | No | |
| `sender_id` | `uuid` | Yes | Null after the sender's account is deleted |
| `body` | `text` | No | 1 to 5,000 characters |
| `edited_at` | `timestamptz` | Yes | `system`. Set by a trigger when `body` changes |
| `deleted_at` | `timestamptz` | Yes | |

- **Primary key:** `id`
- **Foreign keys:** `conversation_id` → `conversations(id)` on delete cascade; `sender_id` → `profiles(id)` on delete set null
- **Indexes:** `(conversation_id, id DESC)`; `(sender_id, id DESC)`
- **Timestamps:** `created_at`, `edited_at`, `deleted_at`

---

## Moderation

### `reports`

Exactly one target column is set. The snapshot preserves what was reported, even if it's later edited or deleted, and is the only route by which staff see message content.

| Column | Type | Null | Notes |
| --- | --- | --- | --- |
| `id` | `uuid` (v7) | No | |
| `reporter_id` | `uuid` | Yes | Null after the reporter's account is deleted |
| `target_profile_id` | `uuid` | Yes | |
| `target_post_id` | `uuid` | Yes | |
| `target_comment_id` | `uuid` | Yes | |
| `target_message_id` | `uuid` | Yes | |
| `target_shelf_id` | `uuid` | Yes | |
| `target_collection_item_id` | `uuid` | Yes | |
| `reason` | `report_reason` | No | |
| `details` | `text` | Yes | Up to 2,000 characters |
| `content_snapshot` | `jsonb` | No | `system`. Captured when the report is filed |
| `status` | `report_status` | No | `staff_only`. Default `open` |
| `assigned_to` | `uuid` | Yes | `staff_only` |
| `resolved_at` | `timestamptz` | Yes | `staff_only` |

- **Primary key:** `id`
- **Foreign keys:** `reporter_id`, `assigned_to` → `profiles(id)` on delete set null; each target → its table on delete set null
- **Unique:** partial `(reporter_id, target_x)` per target column, where not null, so one user can't flood reports on one target
- **Indexes:** `(status, id)`; `assigned_to` where not null; `reporter_id`; an index on each target column where not null
- **Timestamps:** `created_at`, `updated_at`, `resolved_at`
- **Constraints:** a `CHECK` allows at most one target, and requires exactly one at creation through the filing function. Targets may later become null when a target is hard-deleted

### `audit_events`

In the `private` schema (M4). Replaces the planned `moderation_actions` (decision D1). Append-only for application and API roles: no API role has any privilege, rows are added only by `private.record_audit()`, and triggers refuse `UPDATE`, `DELETE` and `TRUNCATE`. A database owner or superuser can still bypass this. See [Audit log](security-rls.md#audit-log).

| Column | Type | Null | Notes |
| --- | --- | --- | --- |
| `id` | `uuid` (v7) | No | Default `private.uuid_v7()` |
| `occurred_at` | `timestamptz` | No | Default `now()` |
| `actor_id` | `uuid` | Yes | Staff member. Null for an operator working in SQL |
| `action` | `private.audit_action` | No | `staff_role_granted`, `staff_role_revoked`, `account_suspended`, `account_reinstated`, `operator_action`. Later steps add values, such as `hide_post` and `merge_game` |
| `target_profile_id` | `uuid` | Yes | |
| `reason` | `text` | No | Trimmed, 1 to 500 characters |
| `metadata` | `jsonb` | No | Before and after values. An object of at most 2 KB. Default `{}` |

- **Primary key:** `id`
- **Foreign keys:** none, deliberately. Deleting an account doesn't change the log, and rows hold no copies of profile data. L4 Reporting adds a report reference
- **Indexes:** `(target_profile_id, id DESC)` and `(actor_id, id DESC)`, each where not null
- **Timestamps:** `occurred_at`. Rows are never updated
- **Retention:** undecided (D10). Nothing removes rows, which is an interim state, not a commitment

---

## Metadata providers

See [ADR-015](architecture-decisions.md#adr-015-metadata-providers-are-replaceable-adapters) for the adapter architecture.

### `external_providers`

| Column | Type | Null | Notes |
| --- | --- | --- | --- |
| `code` | `text` | No | For example `igdb` |
| `name` | `text` | No | |
| `is_enabled` | `boolean` | No | Default `false` |
| `commercial_use_cleared` | `boolean` | No | Default `false`. No sync runs until this is `true` |
| `images_cleared` | `boolean` | No | Default `false`. No images import until this is `true` |
| `attribution_text` | `text` | Yes | |
| `terms_url` | `text` | Yes | |
| `terms_reviewed_at` | `date` | Yes | |
| `rate_limit_per_minute` | `integer` | Yes | |

- **Primary key:** `code`
- **Timestamps:** `created_at`, `updated_at`

### `external_references`

Links our records to a provider's IDs. Our IDs never depend on a provider's.

| Column | Type | Null | Notes |
| --- | --- | --- | --- |
| `id` | `uuid` | No | |
| `provider_code` | `text` | No | |
| `external_id` | `text` | No | |
| `game_id` | `uuid` | Yes | Exactly one of these three |
| `release_id` | `uuid` | Yes | |
| `platform_id` | `uuid` | Yes | |
| `match_confidence` | `numeric(3,2)` | Yes | 0 to 1 |
| `matched_by` | `uuid` | Yes | Null when matched automatically |
| `last_synced_at` | `timestamptz` | Yes | |

- **Primary key:** `id`
- **Foreign keys:** `provider_code` → `external_providers(code)` on delete restrict; `game_id` → `games(id)`, `release_id` → `releases(id)`, `platform_id` → `platforms(id)`, all on delete cascade; `matched_by` → `profiles(id)` on delete set null
- **Unique:** `(provider_code, entity_type, external_id)`, where `entity_type` is a generated column naming the target
- **Indexes:** `game_id`, `release_id`, `platform_id`, `matched_by`, each where not null; `(provider_code, last_synced_at)`
- **Timestamps:** `created_at`, `updated_at`
- **Constraints:** `CHECK (num_nonnulls(game_id, release_id, platform_id) = 1)`

### `provider_records` (in the `private` schema)

Raw provider payloads awaiting matching. The application never reads this directly.

| Column | Type | Null | Notes |
| --- | --- | --- | --- |
| `id` | `uuid` (v7) | No | |
| `provider_code` | `text` | No | |
| `entity_type` | `text` | No | `game`, `release`, `platform` |
| `external_id` | `text` | No | |
| `payload` | `jsonb` | No | Exactly as received |
| `normalized` | `jsonb` | Yes | Adapter output |
| `payload_hash` | `text` | No | Skips unchanged records |
| `status` | `provider_record_status` | No | Default `fetched` |
| `error` | `text` | Yes | |
| `fetched_at` | `timestamptz` | No | |

- **Primary key:** `id`
- **Foreign keys:** `provider_code` → `public.external_providers(code)` on delete restrict
- **Unique:** `(provider_code, entity_type, external_id, payload_hash)`
- **Indexes:** `(status, fetched_at)`; `(provider_code, entity_type, external_id, fetched_at DESC)`
- **Timestamps:** `fetched_at`, `updated_at`

Retention depends on each provider's terms, which may limit how long raw data can be stored.

### `catalog_field_locks`

Stops a provider sync from overwriting a human correction.

| Column | Type | Null | Notes |
| --- | --- | --- | --- |
| `id` | `uuid` | No | |
| `game_id` | `uuid` | Yes | Exactly one of these three |
| `release_id` | `uuid` | Yes | |
| `platform_id` | `uuid` | Yes | |
| `field_name` | `text` | No | |
| `locked_by` | `uuid` | Yes | |
| `reason` | `text` | Yes | |

- **Primary key:** `id`
- **Foreign keys:** `game_id` → `games(id)`, `release_id` → `releases(id)`, `platform_id` → `platforms(id)`, all on delete cascade; `locked_by` → `profiles(id)` on delete set null
- **Unique:** `NULLS NOT DISTINCT (game_id, release_id, platform_id, field_name)`
- **Indexes:** `release_id`, `platform_id`, `locked_by`, each where not null
- **Timestamps:** `created_at`
- **Constraints:** `CHECK (num_nonnulls(game_id, release_id, platform_id) = 1)`

---

## Scale and performance

Rough sizing assumes 1 million users with an average of 300 items each. These are planning figures, not forecasts.

| Table | Rough rows | Approach |
| --- | --- | --- |
| `collection_items` | 300M | Always queried by `owner_id`. UUIDv7 keeps inserts local. Hash partitioning by `owner_id` is the path if needed |
| `likes`, `notifications` | Billions over time | Notifications are purged. Likes can be time-partitioned later |
| `messages` | Billions over time | `(conversation_id, id DESC)` keeps reads narrow. Partition by time when needed |
| `games`, `releases` | Millions | Read-heavy, so cache aggressively at the application layer |

Deliberate exceptions to normalization, each maintained by a trigger:

| Column | Why |
| --- | --- |
| `posts.like_count`, `posts.comment_count`, `comments.like_count` | Counting on every feed row doesn't scale |
| `conversations.last_message_at` | Inbox sort order |
| `posts.subject_completeness` | A deliberate snapshot, not a duplicate: the author's disclosure at posting time, which keeps the post readable if the item goes private |

Aggregates such as Trending Games are computed by scheduled jobs into rollup tables, added when that feature is built. They count public activity only, and very small counts may be suppressed so a rare release doesn't identify its owner.

**Search** starts in PostgreSQL with full-text search and trigram indexes. Trigram matching is weak for Japanese and other non-Latin scripts, so a dedicated search engine is the likely next step. See [ADR-019](architecture-decisions.md#adr-019-search-starts-in-postgresql).

## Not in this design

| Deferred | Add when |
| --- | --- |
| `companies`, `game_companies` | Publisher and developer browsing is needed. `publisher_name` holds the text until then |
| `collection_item_images` | Users can upload photos of individual copies |
| Grading (WATA, VGA) | Graded copies need structured data. Can be added without restructuring |
| Disposal history | Users want records of sold and traded copies |
| `exchange_rates` | Collection valuation is built. Purchase prices keep their original currency |
| `feed_items` | Reading the Following feed on demand gets too slow |
| Hardware and accessories | Out of launch scope under D4. No catalog entities exist for them. A future design would add them separately rather than changing `releases` |

Digital products aren't in this table because they aren't deferred. They're permanently out of scope.

## Impact on the Phase 1 types

No frontend code changes in this phase. These are the changes to expect when the frontend connects.

| Phase 1 | Database | Change needed |
| --- | --- | --- |
| `ReleaseRegion`: `NA`, `EU`, `JP` | `regions.code` | Becomes a wider set of codes. Maps to `ntsc-uc`, `pal`, `ntsc-j` |
| `Release` has one `region` | `region_code` plus `release_markets` | Display composes the classification and the countries |
| A `Release` is always present on an item | `collection_items.release_id` may be unreadable to others | Queries must left-join and show an "Unverified release" placeholder |
| `ItemCompleteness`: 3 values | `completeness`: 4 values | Add `incomplete` |
| `Release.year` | `release_date` + precision | Derive the year |
| `Release.edition` | `edition_name`, `edition_kind`, `variant_name` | Display composes them |
| `Release.coverUrl` | `catalog_images` | Query resolves the primary cover |
| `Collector.avatarUrl` | `profiles.avatar_path` | Query builds the URL |
| `SuggestedCollector.gamesCataloged` | Count of counted copies the viewer can read | Computed, and excludes private and invalid records |
| `Post.viewerHasLiked`, `viewerHasBookmarked` | `likes`, `bookmarks` | Per-viewer, so it can't go in a shared cache |

The seam for this already exists: components read through `src/features/*/queries.ts`, so these changes stay in the data layer.
