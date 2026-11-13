-- M7b-1 Catalog review: audit actions. Enum values can't be used in the transaction
-- that adds them, so they come first, on their own.
--
-- Design: docs/architecture/security-rls.md#catalog-review-m7b-1

alter type private.audit_action add value 'catalog_submission_review_started';
alter type private.audit_action add value 'catalog_submission_approved';
alter type private.audit_action add value 'catalog_submission_changes_requested';
alter type private.audit_action add value 'catalog_submission_rejected';
alter type private.audit_action add value 'catalog_submission_resubmitted';
