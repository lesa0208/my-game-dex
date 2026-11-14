-- M7b-2c: types for merging duplicate releases.
--
-- Design: docs/architecture/security-rls.md#merging-releases-m7b-2c
-- New enum values can't be used in the transaction that adds them, so they come first,
-- in their own migration.

alter type private.audit_action add value 'catalog_release_merged';

-- Owners of copies a merge moved to another release (D13).
alter type public.notification_type add value 'catalog_merge';
