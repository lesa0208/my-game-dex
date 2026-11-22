-- PROPOSAL (M12c-B1, B1-M1, part 0): not a migration until reviewed and moved to supabase/migrations.
--
-- Audit actions for withdrawing and restoring a game-platform pairing. Enum values are added
-- in their own migration, before B1-M1 uses them, because a new value can't be used in the
-- transaction that adds it.
alter type private.audit_action add value if not exists 'catalog_pairing_withdrawn';
alter type private.audit_action add value if not exists 'catalog_pairing_restored';
