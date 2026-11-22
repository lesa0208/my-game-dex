# Integrating the collection, Game Details and wishlist work into `main`

Recorded by the integration review of `m12-w2-wishlist-app`, 2026-11-22. This covers what
the branch brings to `main`, its one database change, and the exact adjustments needed when
the M12c-B1 catalog work (`m12c-b0-catalog-sources`) is integrated after it.

## What the branch contains

Ten feature commits and this review's commit, linear on `main` at `dd07a9f`:

| Commits | Work | Database |
| --- | --- | --- |
| `6c53840`..`0ced894` (6) | Visual collection shelf: Systems, a system's shelf, media and console art, the `/collection/preview` routes on sample data | none |
| `9a696a3` | Real collection integration: the collector's own copies on `/collection/systems` | none |
| `76697ce` | Collector Game Details | none |
| `069d56f` | M12 W1 wishlist database | `20261207100000_m12w1_wishlist.sql` |
| `6540529` | M12 W2 wishlist in the app, the export at version 3 | none |
| integration review | export paging by id, the rollback's lock, test wording | none (rollback script only) |

The `/collection/preview` routes read only `src/dev/seed/shelf.ts`, and only while
`ENABLE_SEED_DATA=true` (as the home feed's sample data on `main` already does); without it
they answer 404 and My Collection hides their link.

## The wishlist migration

- **One migration**, `20261207100000_m12w1_wishlist.sql`: a new table (`wishlist_items`), its
  owner-only SELECT policy, two triggers, private helpers and six SECURITY DEFINER client
  functions granted to `authenticated` only. It changes no existing object, so it can be
  applied to a database with data, and removing the app code alone leaves only an unused
  table.
- **Where it is applied** (updated 2026-11-22): merged into `main` (PR #19) and applied with
  the forward process (`supabase migration up`, never a reset) to the local test stack, which
  holds the M12c-A pilot, and to the local development database, after a verified backup. The
  B1 stack and every hosted database have no wishlist.
- **Order.** Its timestamp is earlier than every B1 proposal (`20261210…`), and it is now
  recorded on two databases, so it can no longer be re-timestamped: B1's migrations must come
  after it, as their timestamps already do.
- **Rollback**, `supabase/rollbacks/20261207100000_m12w1_wishlist.rollback.sql`: a forward
  script that locks the table, then refuses while any entry exists unless
  `mgd.discard_wishlists = 'yes'` is set in the same transaction. Wishlists are collectors'
  own data: export first.

## Adjusting for B1 when it is integrated

B1 keeps its migrations in `docs/proposals/m12c-b1/` and its schema-inventory changes in
`tests/schema_guard_updates.patch`, written against `main` before the wishlist. That patch
will not apply as is. After moving the proposals into `supabase/migrations`:

1. **`01_foundation`**: one array of tables; both change the same line. Use B1's list plus
   `'wishlist_items'` as the last entry (alphabetical order), which gives B1's six new tables
   (`catalog_pairing_origins`, `catalog_pairing_withdrawals`, `catalog_review_batch_approvals`,
   `catalog_review_batch_items`, `catalog_review_batches`, `catalog_review_policy`) and the
   wishlist together.
2. **`03_schema_guards`**: B1's hunk (after `set_catalog_field_lock`) applies with an offset;
   keep both W1 additions (`('wishlist_items', 'authenticated')` and the six wishlist function
   grants).
3. **`10_staff_and_functions`**: B1 reflows the whole SECURITY DEFINER list. Take B1's list and
   insert the six wishlist functions alphabetically: `add_wishlist_item(uuid,jsonb,jsonb)`
   after `add_game_alias(...)`; `get_my_wishlist(text,text,text,integer,text,integer,text)`,
   `get_my_wishlist_for_game(uuid)` and `get_my_wishlist_item(uuid)` after
   `get_my_submission(uuid)`; `remove_wishlist_item(uuid)` after `remove_game_alias(uuid,text)`;
   `update_wishlist_item(uuid,jsonb)` after `update_release(uuid,jsonb,text)`. Keep the
   wishlist branch's staff-role assertion (a before/after comparison) unchanged; its plan stays
   at 49.
4. **`14_audit`**: B1 only (W1 adds no audit action). Apply B1's hunk as is.
5. **Test numbers**: B1's tests are 48 to 51, the wishlist's is 52. No renumbering.
6. **`package.json` and `docs/architecture/security-rls.md`**: both add lines; keep both.

What needs no change, checked against the B1 proposals:

- **Pairing withdrawal** (`withdraw_game_platform`) sets a pairing to `excluded` and restoring
  sets it to `under_review`. Neither deletes a row, so the wishlist's `on delete restrict`
  keys never block B1. A platform wish on a withdrawn pairing reads as
  `platform_unavailable` and is kept, and reads as available again once republished. Adding a
  new wish there is refused.
- **Releases stay on published pairings**: B1 refuses a withdrawal while any release on the
  pairing is published (its W3), so an exact-release wish never points at a release on a
  withdrawn pairing.
- **What "published pairing" means**: after B1 a public pairing has a published, verified
  release or its own verification (I1, I8). Every published release is verified
  (`releases_published_verified`), so the wishlist's rule (a published pairing) and B1's
  public platforms agree.
- **Identity-only games** (published by `publish_game_identity`, with no release) can be
  wished for at the game, platform and region levels, and not at the release level, which is
  as intended.
- **B1's title-key rewrite** changes `games.search_key`. The wishlist searches that same key,
  so wishlist search follows B1's Unicode normalisation without a change.
- **B1's review batches publish with updates** (`games`, `game_platforms`) and never touch
  `wishlist_items`.

After the text merges, run the full `db:test` on a fresh scratch stack and the wishlist,
export and game-details app suites.

## Before merging into `main`

- A human review of the W1 migration (an independent read-only review found no high or
  medium issue). The low findings it raised and their outcome are in the review report.
- The checks in this document's review (full `db:test` on a fresh scratch stack, every app
  suite, typecheck, lint, build) on the final commit.
- No hosting decision depends on this branch. When one is made, the data export streams but
  can take about 10 seconds at the 10,000-wish limit (100 database pages of catalog states).
  Check the host's function duration limit, and the collection's own bound (100,000 copies),
  which is larger.
