# Known failing local checks

Local app checks that fail for reasons outside the change being tested. CI doesn't run them; it runs typecheck, lint, build, secret scans, fresh migrations, pgTAP and the database suites. Each needs its own small fix.

| Check | Fails with | Cause | Since | Fix |
| --- | --- | --- | --- | --- |
| `app:shelf-checks` | `no published release: Super Mario World snes ntsc-uc snes-game-pak-na` | It adds copies of "Super Mario World" releases that the shared catalog fixture (`scripts/fixtures/catalog-search-fixture.sql`) no longer has. | `980c8ed` (M12c-B1, 2026-11-20) | Give the check its own fixture releases, as `app:collector-fast-add-checks` does, or use the fixture's Starfall Odyssey releases. |
| `app:catalog-identity-checks` | `staff see the game's platforms with their physical evidence` | It looks for the heading "Platforms and physical evidence", which the catalog editor UX simplification renamed. | `c020fc8` (M15 catalog UX) | Check the page's current heading and evidence labels. |
| pgTAP `14_audit` after `db:suites` (scratch only) | `refused grants record nothing`, and two more | `db:suites` leaves two `private.audit_events` rows (`catalog_submission_created`, `owner_assigned`), and `14_audit` counts every audit row. CI runs pgTAP before the suites, so it passes there. | M15 | Make that suite's cleanup remove its audit rows. Until then: `begin; set local session_replication_role = replica; delete from private.audit_events; commit;` on scratch. |
| ~~`app:wishlist-checks`, intermittently~~ **Fixed in M16** | `a search over all of them, sorted by title, also loads in under 2 seconds` (fast, but not 30 rows) | Its 3,000 wishes were made with `limit 3000` and no order, so which games they covered depended on the database's row order, and the title search sometimes found fewer than 30. They are now made in a fixed order. | M12 W2 | Done. |

Recorded with PR #34 (collector fast add) and M16, whose changes none of these touch.
