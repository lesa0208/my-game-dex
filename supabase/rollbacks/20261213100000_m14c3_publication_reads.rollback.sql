-- Rollback of 20261213100000_m14c3_publication_reads: removes the approval preview, the
-- publication queue, the two _as_seen wrappers, their private helpers and the two indexes.
-- Nothing else changed: the writers they call are untouched, and nothing written depends on them.
drop function if exists public.list_publication_queue(text, text, timestamptz, uuid, uuid, integer);
drop function if exists public.get_batch_approval_preview(uuid, integer);
drop function if exists private.identity_publication_own(uuid, uuid, uuid, uuid);
drop function if exists private.identity_publication_block(public.games, public.game_platforms);
drop index if exists public.game_platforms_physical_basis_idx;
drop function if exists public.approve_review_batch_as_seen(uuid, text, integer);
drop function if exists public.publish_game_identity_as_seen(uuid, uuid[], text, bigint, timestamptz[]);
drop index if exists public.games_identity_verified_idx;
