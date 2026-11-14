-- M7b-2b: types for excluding releases and restoring exclusions.
--
-- Design: docs/architecture/security-rls.md#excluding-and-restoring-releases-m7b-2b
-- New enum values can't be used in the transaction that adds them, so they come first,
-- in their own migration.

-- Why a release is outside the physical-only scope (D7). Owners of preserved copies see
-- it; the staff reason stays private.
create type private.exclusion_reason as enum (
  'download_code',
  'game_key_card',
  'installer_only',
  'no_game_data',
  'not_physical_release',
  'other'
);
revoke all on type private.exclusion_reason from public, anon, authenticated, service_role;

alter type private.audit_action add value 'catalog_release_excluded';
alter type private.audit_action add value 'catalog_exclusion_restored';
