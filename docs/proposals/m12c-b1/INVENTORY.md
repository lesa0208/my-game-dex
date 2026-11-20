# M12c-B1 inventory of changed objects and privileges

**For:** the independent SQL reviewer. **Generated**, not hand-written:
1. a fresh scratch stack was built from the 72 current migrations;
2. its catalog was read (`public` and `private`: functions with their grants, columns, constraints, indexes, triggers, policies, RLS flags and enum values);
3. B1-M0, B1-M1 and B1-M2 were applied in order, and the catalog was read again;
4. the three rollbacks were applied, and the catalog was read a third time.

The raw lists are in `inventory/` in the review archive. The stack was destroyed afterwards.

## Summary

| | Count |
| --- | --- |
| Functions new | 24 |
| Functions replaced (same signature) | 7 |
| Functions executable by `authenticated` (new) | 10 |
| New functions executable by `anon`, `service_role`, `catalog_importer` or `PUBLIC` | 0 |
| Replaced functions whose grants changed | 0 (the two public reads keep `anon, authenticated`) |
| Tables new | 6 (all in `private`) |
| Columns added to existing tables | 4 (`public.game_platforms`) |
| Table or column grant changes, to any role | 0 |
| RLS policy changes | 0 |
| Constraints / indexes / triggers added | 53 / 8 / 5 |
| Enum values added (`private.audit_action`) | 7 |
| Objects removed | 7 lines, all the old definitions of the 7 replaced functions |

## Functions

Every function has a fixed `search_path` (`''`). "Executable by" lists every role other than the owner, `postgres`.

| Migration | Function | New or replaced | Security | `search_path` | Executable by |
| --- | --- | --- | --- | --- | --- |
| B1-M0 | `private.catalog_search_key(p_title text)` | replaced (was: none (owner only)) | invoker | `''` | none (owner only) |
| B1-M0 | `private.import_title_key(p_title text)` | replaced (was: none (owner only)) | invoker | `''` | none (owner only) |
| B1-M1 | `private.catalog_game_listed(p_game uuid, p_platforms uuid[])` | new | invoker | `''` | none (owner only) |
| B1-M1 | `private.catalog_game_platforms_json(p_game uuid)` | replaced (was: none (owner only)) | invoker | `''` | none (owner only) |
| B1-M1 | `private.check_publication_of(p_game uuid, p_platform uuid)` | replaced (was: none (owner only)) | invoker | `''` | none (owner only) |
| B1-M1 | `private.exclusion_plan(p_release uuid)` | replaced (was: none (owner only)) | invoker | `''` | none (owner only) |
| B1-M1 | `private.game_has_identity_pairing(p_game uuid)` | new | invoker | `''` | none (owner only) |
| B1-M1 | `private.guard_pairing_withdrawal()` | new | invoker | `''` | none (owner only) |
| B1-M1 | `private.pairing_created_by(p_me uuid, p_game uuid, p_platform uuid)` | new | invoker | `''` | none (owner only) |
| B1-M1 | `private.pairing_withdrawal_plan(p_game uuid, p_platform uuid)` | new | invoker | `''` | none (owner only) |
| B1-M1 | `private.record_pairing_origin()` | new | invoker | `''` | none (owner only) |
| B1-M1 | `private.require_pairing_basis(p_basis jsonb)` | new | invoker | `''` | none (owner only) |
| B1-M1 | `public.get_pairing_withdrawal_preview(p_game uuid, p_platform uuid)` | new | definer | `''` | authenticated |
| B1-M1 | `public.get_release_picker(p_game text, p_platform text, p_region text, p_release uuid)` | replaced (was: anon, authenticated) | definer | `''` | anon, authenticated |
| B1-M1 | `public.publish_game_identity(p_game uuid, p_platforms uuid[], p_reason text, p_expected_revision bigint)` | new | definer | `''` | authenticated |
| B1-M1 | `public.restore_game_platform(p_withdrawal uuid, p_reason text, p_expected_game_revision bigint)` | new | definer | `''` | authenticated |
| B1-M1 | `public.search_catalog(p_query text, p_platforms text[], p_limit integer, p_cursor text)` | replaced (was: anon, authenticated) | definer | `''` | anon, authenticated |
| B1-M1 | `public.verify_game_platform(p_game uuid, p_platform uuid, p_basis jsonb, p_reason text, p_expected_game_revision bigint)` | new | definer | `''` | authenticated |
| B1-M1 | `public.withdraw_game_platform(p_game uuid, p_platform uuid, p_reason text, p_expected_game_revision bigint)` | new | definer | `''` | authenticated |
| B1-M2 | `private.guard_review_batch()` | new | invoker | `''` | none (owner only) |
| B1-M2 | `private.guard_review_batch_approval()` | new | invoker | `''` | none (owner only) |
| B1-M2 | `private.guard_review_batch_item()` | new | invoker | `''` | none (owner only) |
| B1-M2 | `private.hypergeometric_cdf(p_c integer, p_n integer, p_lot integer, p_defects integer)` | new | invoker | `''` | none (owner only) |
| B1-M2 | `private.ln_choose(p_n integer, p_k integer)` | new | invoker | `''` | none (owner only) |
| B1-M2 | `private.review_critical_signal(p_flag text)` | new | invoker | `''` | none (owner only) |
| B1-M2 | `private.review_sample_size(p_lot integer, p_tolerable numeric, p_confidence numeric, p_c integer)` | new | invoker | `''` | none (owner only) |
| B1-M2 | `public.approve_review_batch(p_batch uuid, p_reason text)` | new | definer | `''` | authenticated |
| B1-M2 | `public.create_review_batch(p_run uuid, p_platform uuid, p_reason text)` | new | definer | `''` | authenticated |
| B1-M2 | `public.get_review_batch(p_batch uuid)` | new | definer | `''` | authenticated |
| B1-M2 | `public.record_batch_outcome(p_batch uuid, p_game uuid, p_outcome text, p_critical_error text, p_note text)` | new | definer | `''` | authenticated |
| B1-M2 | `public.reject_review_batch(p_batch uuid, p_reason text)` | new | definer | `''` | authenticated |

## Tables and columns

- **`private.catalog_pairing_origins`** (new), 4 constraints: `created_at timestamp not null`, `creator_id uuid`, `game_id uuid not null`, `origin text not null`, `platform_id uuid not null`
- **`private.catalog_pairing_withdrawals`** (new), 11 constraints: `claimed_copies integer not null`, `game_id uuid not null`, `game_revision bigint not null`, `id uuid not null`, `platform_id uuid not null`, `previous_status text not null`, `previous_verification jsonb`, `reason text not null`, `restore_reason text`, `restored_at timestamp`, `restored_by uuid`, `withdrawn_at timestamp not null`, `withdrawn_by uuid`
- **`private.catalog_review_batch_approvals`** (new), 4 constraints: `approved_at timestamp not null`, `approver_id uuid not null`, `batch_id uuid not null`, `reason text not null`
- **`private.catalog_review_batch_items`** (new), 11 constraints: `batch_id uuid not null`, `critical_error text`, `critical_flags ARRAY not null`, `flags ARRAY not null`, `frozen_game_revision bigint not null`, `game_id uuid not null`, `note text`, `outcome text`, `platform_id uuid not null`, `provider_record_id uuid`, `recorded_at timestamp`, `reviewed_by uuid`, `sampled boolean not null`
- **`private.catalog_review_batches`** (new), 15 constraints: `acceptance_number integer not null`, `confidence numeric not null`, `content_sha256 text not null`, `created_at timestamp not null`, `created_by uuid`, `decided_at timestamp`, `decision_reason text`, `flagged_count integer not null`, `id uuid not null`, `import_run_id uuid not null`, `item_count integer not null`, `platform_id uuid not null`, `reason text not null`, `required_approvals integer not null`, `sample_size integer not null`, `seed uuid not null`, `status text not null`, `tolerable_error numeric not null`
- **`private.catalog_review_policy`** (new), 6 constraints: `acceptance_number integer not null`, `confidence numeric not null`, `id boolean not null`, `second_approval_above integer not null`, `tolerable_error numeric not null`, `updated_at timestamp not null`
- **`public.game_platforms`** (existing table, new columns), 2 constraints: `verification_basis jsonb`, `verified_at timestamp`, `verified_by uuid`, `verified_game_revision bigint`

**No role is granted anything on these tables.** There are 0 table or column grant changes. `private` has no `USAGE` for `anon`, `authenticated` or `service_role` (M0 foundation), so the tables are reachable only through the definer functions above. The four new `public.game_platforms` columns get no column grant: the table is granted column by column (`game_id`, `platform_id`, `status`, `created_at`, `updated_at` to `anon` and `authenticated`), so who verified a pairing, when and why stays unreadable to every role but the owner (I8).

**RLS:**
- `private.catalog_pairing_origins enabled=false forced=false`
- `private.catalog_pairing_withdrawals enabled=false forced=false`
- `private.catalog_review_batch_approvals enabled=false forced=false`
- `private.catalog_review_batch_items enabled=false forced=false`
- `private.catalog_review_batches enabled=false forced=false`
- `private.catalog_review_policy enabled=false forced=false`

RLS is not enabled on the new private tables. This follows the existing private catalog tables, `private.catalog_record_origins` and `private.catalog_verifications`, which also have it off; the other 24 private tables have it on. **Reviewer decision:** whether to enable RLS (with no policies) on all eight as defense in depth. Definer functions run as the owner and are unaffected.

## Triggers, indexes and enum values

- Trigger `private.catalog_pairing_withdrawals guard_pairing_withdrawal`
- Trigger `private.catalog_review_batch_approvals guard_review_batch_approval`
- Trigger `private.catalog_review_batch_items guard_review_batch_item`
- Trigger `private.catalog_review_batches guard_review_batch`
- Trigger `public.game_platforms record_pairing_origin`
- Index `private.catalog_pairing_origins catalog_pairing_origins_pkey`
- Index `private.catalog_pairing_withdrawals catalog_pairing_withdrawals_open`
- Index `private.catalog_pairing_withdrawals catalog_pairing_withdrawals_pkey`
- Index `private.catalog_review_batch_approvals catalog_review_batch_approvals_pkey`
- Index `private.catalog_review_batch_items catalog_review_batch_items_game_idx`
- Index `private.catalog_review_batch_items catalog_review_batch_items_pkey`
- Index `private.catalog_review_batches catalog_review_batches_pkey`
- Index `private.catalog_review_policy catalog_review_policy_pkey`
- Enum value `private.audit_action catalog_batch_approval_recorded`
- Enum value `private.audit_action catalog_batch_approved`
- Enum value `private.audit_action catalog_batch_created`
- Enum value `private.audit_action catalog_batch_outcome_recorded`
- Enum value `private.audit_action catalog_batch_rejected`
- Enum value `private.audit_action catalog_pairing_restored`
- Enum value `private.audit_action catalog_pairing_withdrawn`

## After the three rollbacks

- **Pre-B1 objects missing or different:** 0. Every replaced function is byte-identical to its pre-B1 definition again (same `pg_get_functiondef` hash), with the same grants.
- **Objects that remain:** 163 lines. They are the history the rollbacks keep by design:
  - the six private tables, with their constraints and guard triggers;
  - the four `game_platforms` verification columns and their two constraints;
  - the seven enum values.
- **Helper functions that remain:**
  - `private.guard_pairing_withdrawal()`
  - `private.guard_review_batch()`
  - `private.guard_review_batch_approval()`
  - `private.guard_review_batch_item()`
  - `private.hypergeometric_cdf(p_c integer, p_n integer, p_lot integer, p_defects integer)`
  - `private.ln_choose(p_n integer, p_k integer)`
  - `private.pairing_created_by(p_me uuid, p_game uuid, p_platform uuid)`
  - `private.record_pairing_origin()`
  - `private.require_pairing_basis(p_basis jsonb)`
  - `private.review_critical_signal(p_flag text)`
  - `private.review_sample_size(p_lot integer, p_tolerable numeric, p_confidence numeric, p_c integer)`

  They are executable by `postgres` only. The pairing-origin trigger itself is dropped; its function stays, unused.
