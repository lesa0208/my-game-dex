-- M11a-4a: per-account limits for the two expensive things a member can ask the server
-- to do: download a data export (many reads) and upload a photo (an image decoded on the
-- server). Counted in the database, so every app instance shares one count.
--
-- Design: docs/architecture/security-rls.md#personal-data-export-m11a-4a
-- - Each call counts against the caller only (auth.uid()); nothing names another account.
-- - Fixed kinds and limits, written here: a client can't choose a window or a ceiling.
-- - A refused call isn't counted, so asking again while refused doesn't extend the wait.
-- - Rows older than their window are removed as the caller's next call runs: at most
--   one window of times is kept per account and kind, and nothing else (no IP, no
--   content). They go with the account (on delete cascade).
-- - Not audited: these are throttles, not decisions.

create table private.request_slots (
  user_id uuid not null references public.profiles (id) on delete cascade,
  kind text not null check (kind in ('data_export', 'avatar_upload')),
  taken_at timestamptz not null default pg_catalog.now()
);

create index request_slots_user_kind_idx on private.request_slots (user_id, kind, taken_at);

alter table private.request_slots enable row level security;
revoke all on private.request_slots from public, anon, authenticated, service_role;

-- Takes one slot of p_kind for the caller, or says when the next one frees up.
-- Returns {allowed: true} or {allowed: false, retry_at}. Serialized per account and
-- kind, so concurrent requests can't both take the last slot.
create function public.take_request_slot(p_kind text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_me uuid := (select auth.uid());
  v_max integer;
  v_window interval;
  v_used integer;
  v_oldest timestamptz;
begin
  if v_me is null or not exists (select 1 from public.profiles p where p.id = v_me) then
    raise exception 'not permitted' using errcode = '42501';
  end if;
  case p_kind
    when 'data_export' then v_max := 3; v_window := interval '1 hour';
    when 'avatar_upload' then v_max := 10; v_window := interval '1 hour';
    else raise exception 'invalid kind' using errcode = '22023';
  end case;

  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('request_slot:' || v_me::text || ':' || p_kind, 0));
  delete from private.request_slots s where s.user_id = v_me and s.kind = p_kind and s.taken_at <= pg_catalog.now() - v_window;
  select count(*), min(s.taken_at) into v_used, v_oldest from private.request_slots s where s.user_id = v_me and s.kind = p_kind;
  if v_used >= v_max then
    return pg_catalog.jsonb_build_object('allowed', false, 'retry_at', v_oldest + v_window);
  end if;
  insert into private.request_slots (user_id, kind) values (v_me, p_kind);
  return pg_catalog.jsonb_build_object('allowed', true);
end;
$$;

revoke all on function public.take_request_slot(text) from public, anon, authenticated, service_role;
grant execute on function public.take_request_slot(text) to authenticated;
