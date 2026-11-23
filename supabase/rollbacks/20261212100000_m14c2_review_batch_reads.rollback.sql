-- Rollback of 20261212100000_m14c2_review_batch_reads: removes the four staff reads, their
-- private helpers and the listing index. Nothing else changed, and nothing written depends on them.
drop function if exists public.get_review_batch_member(uuid, uuid);
drop function if exists public.list_review_batch_members(uuid, text, uuid, integer);
drop function if exists public.get_review_batch_overview(uuid);
drop function if exists public.list_review_batches(text, text, uuid, integer);
drop function if exists private.review_person(uuid, uuid);
drop function if exists private.review_external_keys(jsonb);
drop function if exists private.review_source_summary(jsonb);
drop function if exists private.json_safe_strings(jsonb, text, integer, integer);
drop function if exists private.review_member_rank(boolean, text[], text[]);
drop index if exists private.catalog_review_batches_created_idx;
