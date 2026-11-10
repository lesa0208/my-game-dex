-- M5b Catalog import: audit actions the importer needs.
--
-- Design: docs/architecture/security-rls.md#catalog-import
-- A new enum value can't be used in the transaction that adds it, so these come
-- first, in their own migration.

-- An import run started, resumed or finished. Changes it makes to catalog records
-- use the catalog_record_* actions, with no actor.
alter type private.audit_action add value 'catalog_import_run';

-- An operator recorded a source's terms review and commercial-use clearance.
alter type private.audit_action add value 'catalog_provider_cleared';
