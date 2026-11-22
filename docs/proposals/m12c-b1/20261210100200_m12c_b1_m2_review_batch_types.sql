-- PROPOSAL (M12c-B1, B1-M2, part 1): not a migration until reviewed and moved to supabase/migrations.
--
-- Audit actions for review batches. Enum values are added in their own migration, as earlier
-- milestones do, because a new value can't be used in the transaction that adds it.
alter type private.audit_action add value if not exists 'catalog_batch_created';
alter type private.audit_action add value if not exists 'catalog_batch_outcome_recorded';
alter type private.audit_action add value if not exists 'catalog_batch_approval_recorded';
alter type private.audit_action add value if not exists 'catalog_batch_approved';
alter type private.audit_action add value if not exists 'catalog_batch_rejected';
