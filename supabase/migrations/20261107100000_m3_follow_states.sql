-- M3 Authorization: follow states.
--
-- In its own migration, because a new enum value can't be used in the transaction
-- that adds it. Semantics: docs/architecture/security-rls.md#follow-requests

alter type public.follow_status add value 'rejected';
alter type public.follow_status add value 'cancelled';
