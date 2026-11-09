-- M5b Catalog import: audit actions for reclassifying imported candidates.
--
-- Design: docs/architecture/security-rls.md#catalog-import
-- A new enum value can't be used in the transaction that adds it, so these come
-- first, in their own migration.

-- An import withdrew an untouched candidate it created, because its source now says
-- it isn't a physical release for the platform.
alter type private.audit_action add value 'catalog_record_withdrawn';

-- An import sent a candidate to the editor review queue instead.
alter type private.audit_action add value 'catalog_review_queued';

-- An editor resolved an item in the review queue.
alter type private.audit_action add value 'catalog_review_resolved';
