-- M5c Catalog search: types for editor-curated game aliases.
--
-- Design: docs/architecture/security-rls.md#catalog-search
-- A new enum value can't be used in the transaction that adds it, so these come
-- first, in their own migration.

-- What kind of other title an alias is. An alias is always an editor's decision:
-- titles that imports found are never made public without one.
create type public.game_alias_kind as enum (
  'alternate',     -- another title the game is known by
  'regional',      -- the title used in a region
  'romanized',     -- a romanization of a non-Latin title
  'translated',    -- a translation of the title
  'abbreviation'   -- a common short form
);

-- An editor added an alias to a game.
alter type private.audit_action add value 'catalog_alias_added';

-- An editor removed one.
alter type private.audit_action add value 'catalog_alias_removed';
