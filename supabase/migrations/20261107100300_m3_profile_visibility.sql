-- M3 Authorization: profile cards respect blocks.
--
-- Replaces the M2 read policy. Signed-out visitors keep the same rule, because public
-- means public. Signed-in users stop seeing a card when a block exists in either
-- direction. The public columns don't change.
--
-- The viewer's block list is computed once per query. RLS checks must run before any
-- non-leakproof filter such as LIKE, so a per-row function would run on every account:
-- 666 ms against 50,000 accounts for a handle search.

drop policy profiles_read on public.profiles;

create policy profiles_read_anon on public.profiles
  for select to anon
  using (handle is not null and account_status = 'active');

create policy profiles_read_authenticated on public.profiles
  for select to authenticated
  using (handle is not null and account_status = 'active' and not (id = any ((select private.block_peers())::uuid[])));
