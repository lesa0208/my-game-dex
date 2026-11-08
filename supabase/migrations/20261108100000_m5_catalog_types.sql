-- M5a Catalog: types the catalog needs.
--
-- Design: docs/architecture/database-schema.md#gaming-catalog
-- A new enum value can't be used in the transaction that adds it, so these come
-- first, in their own migration.

-- An additional piece of game media in a mixed edition (R6, ADR-034).
alter type public.component_kind add value 'game_media';

-- How a physical release relates to a hardware requirement (ADR-033).
create type public.requirement_level as enum ('required', 'partial', 'not_compatible', 'compatible');

-- Catalog editor actions. The target is a game or release, named in metadata,
-- because audit_events.target_profile_id refers only to accounts.
alter type private.audit_action add value 'catalog_record_created';
alter type private.audit_action add value 'catalog_record_updated';
alter type private.audit_action add value 'catalog_record_verified';
alter type private.audit_action add value 'catalog_record_published';
alter type private.audit_action add value 'catalog_field_locked';
alter type private.audit_action add value 'catalog_field_unlocked';
