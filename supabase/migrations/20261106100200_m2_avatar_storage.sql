-- M2 Identity: avatar storage.
--
-- Design: docs/architecture/security-rls.md#avatar-storage
-- The bucket is public for reads because a profile card is public. Nothing else on
-- storage.objects is touched: with no policy for this bucket, clients can't upload,
-- overwrite, list or delete. Files arrive only through the server workflow in
-- src/features/avatars, after being validated and re-encoded.

-- Accepts only the re-encoded output. JPEG and PNG are accepted as input by the
-- server, never stored as uploaded.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('avatars', 'avatars', true, 2097152, array['image/webp']);

-- Server only. It records a file that already exists in the caller's folder. The
-- server must have verified the user's session before calling this. Returns the
-- previous path, so the server can remove that file.
create function public.set_avatar_path(p_user_id uuid, p_path text)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_previous text;
  v_status public.account_status;
begin
  select p.avatar_path, p.account_status into v_previous, v_status
  from public.profiles p
  where p.id = p_user_id
  for update;

  if not found then
    raise exception 'account not found' using errcode = 'P0002';
  end if;

  if p_path is not null then
    if v_status <> 'active' then
      raise exception 'account not eligible' using errcode = '42501';
    end if;

    if not exists (
      select 1 from storage.objects o
      where o.bucket_id = 'avatars' and o.name = p_path
    ) then
      raise exception 'avatar file not found' using errcode = 'P0002';
    end if;
  end if;

  -- The CHECK on profiles enforces the folder and file name.
  update public.profiles set avatar_path = p_path where id = p_user_id;

  return v_previous;
end;
$$;

revoke all on function public.set_avatar_path(uuid, text) from public, anon, authenticated, service_role;
grant execute on function public.set_avatar_path(uuid, text) to service_role;
