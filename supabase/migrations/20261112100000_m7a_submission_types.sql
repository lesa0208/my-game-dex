-- M7a Catalog submissions: audit actions, and a review status for a submission its
-- submitter withdrew before review. In their own migration, because a new enum value
-- can't be used in the transaction that adds it.
--
-- Design: docs/architecture/security-rls.md#catalog-submissions-m7a

alter type private.audit_action add value 'catalog_submission_created';
alter type private.audit_action add value 'catalog_submission_updated';
alter type private.audit_action add value 'catalog_submission_withdrawn';

alter type public.catalog_review_status add value 'withdrawn';
