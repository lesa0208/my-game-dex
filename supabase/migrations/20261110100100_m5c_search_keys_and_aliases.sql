-- M5c Catalog search: search keys, published-only indexes, and editor-curated aliases.
--
-- Design: docs/architecture/security-rls.md#catalog-search
-- Search compares normalized keys, not raw titles. The M5b import key keeps only
-- a-z and 0-9, which suits matching source records but drops Japanese and other
-- non-Latin titles entirely, so search has its own key that keeps letters of every
-- script. The keys are stored generated columns, which clients can't read: computing
-- them per row at query time made a prefix search over 50,000 games take about a
-- second. The game and release indexes are partial on status = 'published'
-- (ADR-014's mitigation), so an unpublished record is never in them.
--
-- A generated column has no value yet in a BEFORE UPDATE trigger, so the M5b
-- revision trigger would see every update as a content change. It is replaced to
-- ignore these derived columns, and is otherwise unchanged.
--
-- Aliases are a new public table that only editors write, through audited functions.
-- Titles found by imports (private.game_title_keys) stay private: they become
-- searchable only when an editor adds them as aliases.

-- ---------------------------------------------------------------------------
-- 1. The search key
-- ---------------------------------------------------------------------------

-- Lower case, common accents removed, "&" read as "and", apostrophes dropped, a
-- trailing ", The" moved to the front, everything but letters and digits of any
-- script a single space, a leading "the", "an" or "a" (before a word of three or
-- more letters) dropped, Roman numerals II to IX as digits, and "part 2" as "2".
-- Null when nothing is left. Marked immutable for the expression indexes: if this
-- function ever changes, the indexes that use it must be rebuilt in the same migration.
create function private.catalog_search_key(p_title text)
returns text
language plpgsql
immutable
parallel safe
set search_path = ''
as $$
declare
  v text;
  v_tokens text[];
  v_out text[] := '{}';
  v_roman constant jsonb := '{"ii": "2", "iii": "3", "iv": "4", "vi": "6", "vii": "7", "viii": "8", "ix": "9"}';
  i integer;
begin
  if p_title is null then
    return null;
  end if;
  v := pg_catalog.translate(pg_catalog.lower(p_title), 'àáâãäåāçćčèéêëēěìíîïīłñńòóôõöøōùúûüūýÿžšśźżß', 'aaaaaaaccceeeeeeiiiiilnnooooooouuuuuyyzsszzs');
  v := pg_catalog.replace(v, '&', ' and ');
  v := pg_catalog.regexp_replace(v, '[''`´‘’]', '', 'g');
  v := pg_catalog.regexp_replace(v, '^(.*), (the|a|an)( - .*)?$', '\2 \1\3');
  v := pg_catalog.btrim(pg_catalog.regexp_replace(v, '[^[:alnum:]]+', ' ', 'g'));
  if v = '' then
    return null;
  end if;
  v_tokens := pg_catalog.string_to_array(v, ' ');
  if cardinality(v_tokens) > 1 and (v_tokens[1] in ('the', 'an') or (v_tokens[1] = 'a' and pg_catalog.char_length(v_tokens[2]) >= 3)) then
    v_tokens := v_tokens[2:];
  end if;
  for i in 1 .. cardinality(v_tokens) loop
    if v_roman ? v_tokens[i] then
      v_tokens[i] := v_roman ->> v_tokens[i];
    end if;
  end loop;
  for i in 1 .. cardinality(v_tokens) loop
    continue when v_tokens[i] = 'part' and i < cardinality(v_tokens) and v_tokens[i + 1] ~ '^[0-9]+$';
    v_out := v_out || v_tokens[i];
  end loop;
  return pg_catalog.left(pg_catalog.array_to_string(v_out, ' '), 200);
end;
$$;

-- The key without word breaks, so "ClayFighter" compares with "Clay Fighter".
create function private.catalog_compact_key(p_title text)
returns text
language sql
immutable
parallel safe
set search_path = ''
as $$
  select pg_catalog.replace(private.catalog_search_key(p_title), ' ', '')
$$;

-- The key's words, for matching every word of a query in any order.
create function private.catalog_search_words(p_title text)
returns tsvector
language sql
immutable
parallel safe
set search_path = ''
as $$
  select pg_catalog.to_tsvector('pg_catalog.simple'::regconfig, coalesce(private.catalog_search_key(p_title), ''))
$$;

-- ---------------------------------------------------------------------------
-- 2. Stored keys and published-only indexes
-- ---------------------------------------------------------------------------

-- Derived from the title, so never edited and never part of a record's identity.
-- The column grants (M5a) don't include them, so clients can't read them.
alter table public.games
  add column search_key text generated always as (private.catalog_search_key(title)) stored,
  add column search_compact text generated always as (private.catalog_compact_key(title)) stored,
  add column search_words tsvector generated always as (private.catalog_search_words(title)) stored;
alter table public.releases
  add column local_title_key text generated always as (private.catalog_search_key(local_title)) stored;

create index games_search_key_idx on public.games (search_key text_pattern_ops) where status = 'published';
create index games_search_compact_idx on public.games (search_compact) where status = 'published';
create index games_search_words_idx on public.games using gin (search_words) where status = 'published';
create index games_search_trgm_idx on public.games using gin (search_key extensions.gin_trgm_ops) where status = 'published';

create index releases_search_local_key_idx on public.releases (local_title_key text_pattern_ops)
  where status = 'published' and local_title_key is not null;
create index releases_search_local_trgm_idx on public.releases using gin (local_title_key extensions.gin_trgm_ops)
  where status = 'published' and local_title_key is not null;
create index releases_search_code_idx on public.releases (pg_catalog.upper(product_code)) where status = 'published' and product_code is not null;

-- The M5b revision trigger, ignoring the derived search columns as well. In a BEFORE
-- trigger they have no value yet, so comparing them would raise the revision on
-- every update, verification included.
create or replace function private.bump_catalog_revision()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if (pg_catalog.to_jsonb(new) - array['revision', 'updated_at', 'verified_at', 'verified_by', 'search_key', 'search_compact', 'search_words', 'local_title_key'])
       is distinct from (pg_catalog.to_jsonb(old) - array['revision', 'updated_at', 'verified_at', 'verified_by', 'search_key', 'search_compact', 'search_words', 'local_title_key'])
     or new.revision is distinct from old.revision then
    new.revision := old.revision + 1;
  end if;
  return new;
end;
$$;
create index releases_published_game_idx on public.releases (game_id, platform_id) where status = 'published';
create index releases_published_platform_idx on public.releases (platform_id, game_id) where status = 'published';

-- ---------------------------------------------------------------------------
-- 3. Aliases
-- ---------------------------------------------------------------------------

-- Other titles of a game that an editor confirmed. Public when the game is.
create table public.game_aliases (
  id uuid primary key default private.uuid_v7(),
  game_id uuid not null references public.games (id) on delete cascade,
  title text not null check (char_length(title) between 1 and 200 and title = btrim(title)),
  kind public.game_alias_kind not null,
  language_code text check (language_code ~ '^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$'),
  region_code text references public.region_codes (code) on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  search_key text not null generated always as (private.catalog_search_key(title)) stored,
  search_compact text not null generated always as (private.catalog_compact_key(title)) stored,
  search_words tsvector not null generated always as (private.catalog_search_words(title)) stored,
  constraint game_aliases_known_region check (region_code is distinct from 'unknown')
);

-- The same alias once per game, language and region, compared by key.
create unique index game_aliases_unique on public.game_aliases (game_id, search_key, language_code, region_code) nulls not distinct;
create index game_aliases_search_key_idx on public.game_aliases (search_key text_pattern_ops);
create index game_aliases_search_compact_idx on public.game_aliases (search_compact);
create index game_aliases_search_words_idx on public.game_aliases using gin (search_words);
create index game_aliases_search_trgm_idx on public.game_aliases using gin (search_key extensions.gin_trgm_ops);
create index game_aliases_region_idx on public.game_aliases (region_code) where region_code is not null;

create trigger set_updated_at before update on public.game_aliases
  for each row execute function private.set_updated_at();

alter table public.game_aliases enable row level security;

-- Readable when the game is published; editors read all. Nobody writes directly.
create policy game_aliases_read_anon on public.game_aliases
  for select to anon
  using (exists (select 1 from public.games g where g.id = game_id and g.status = 'published'));
create policy game_aliases_read_authenticated on public.game_aliases
  for select to authenticated
  using (
    exists (select 1 from public.games g where g.id = game_id and g.status = 'published')
    or (select private.is_catalog_editor())
  );

grant select (id, game_id, title, kind, language_code, region_code, created_at, updated_at)
  on public.game_aliases to anon, authenticated;

-- ---------------------------------------------------------------------------
-- 4. Editor operations
-- ---------------------------------------------------------------------------

-- Adds an alias, with the editor's reason. Adding the same alias again returns the
-- existing one and records nothing. An alias that only repeats the game's title is
-- refused, so search results never show a game's own title as an alias.
create function public.add_game_alias(
  p_game uuid,
  p_title text,
  p_kind public.game_alias_kind,
  p_language_code text default null,
  p_region_code text default null,
  p_reason text default null
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_me uuid;
  v_reason text;
  v_title text;
  v_game_title text;
  v_id uuid;
begin
  v_me := private.begin_catalog_edit();
  v_reason := private.require_reason(p_reason);
  v_title := pg_catalog.btrim(p_title);
  if p_kind is null or v_title is null or private.catalog_search_key(v_title) is null then
    raise exception 'invalid changes' using errcode = '22023';
  end if;
  select g.title into v_game_title from public.games g where g.id = p_game and g.status not in ('merged', 'excluded') for share;
  if not found then
    raise exception 'record unavailable' using errcode = 'P0001';
  end if;
  if private.catalog_search_key(v_title) = private.catalog_search_key(v_game_title) then
    raise exception 'alias repeats the title' using errcode = '22023';
  end if;

  insert into public.game_aliases (game_id, title, kind, language_code, region_code)
  values (p_game, v_title, p_kind, p_language_code, p_region_code)
  on conflict (game_id, search_key, language_code, region_code) do nothing
  returning id into v_id;
  if v_id is null then
    select a.id into v_id from public.game_aliases a
    where a.game_id = p_game and a.search_key = private.catalog_search_key(v_title)
      and a.language_code is not distinct from p_language_code and a.region_code is not distinct from p_region_code;
    return v_id;
  end if;

  perform private.record_catalog_audit(v_me, 'catalog_alias_added', 'game', p_game, v_reason,
    pg_catalog.jsonb_build_object('alias_id', v_id, 'title', v_title, 'kind', p_kind,
      'language_code', p_language_code, 'region_code', p_region_code));
  return v_id;
end;
$$;

-- Removes an alias, with the editor's reason. The audit row keeps what it was.
create function public.remove_game_alias(p_alias uuid, p_reason text)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_me uuid;
  v_reason text;
  v_alias public.game_aliases;
begin
  v_me := private.begin_catalog_edit();
  v_reason := private.require_reason(p_reason);
  select a.* into v_alias from public.game_aliases a where a.id = p_alias;
  if not found then
    return false;
  end if;
  perform 1 from public.games g where g.id = v_alias.game_id for share;
  delete from public.game_aliases a where a.id = p_alias returning a.* into v_alias;
  if not found then
    return false;
  end if;
  perform private.record_catalog_audit(v_me, 'catalog_alias_removed', 'game', v_alias.game_id, v_reason,
    pg_catalog.jsonb_build_object('alias_id', v_alias.id, 'title', v_alias.title, 'kind', v_alias.kind,
      'language_code', v_alias.language_code, 'region_code', v_alias.region_code));
  return true;
end;
$$;

-- ---------------------------------------------------------------------------
-- 5. Access
-- ---------------------------------------------------------------------------

do $$
declare
  v_signature text;
begin
  foreach v_signature in array array[
    'private.catalog_search_key(text)',
    'private.catalog_compact_key(text)',
    'private.catalog_search_words(text)'
  ] loop
    execute format('revoke all on function %s from public, anon, authenticated, service_role, catalog_importer', v_signature);
  end loop;

  foreach v_signature in array array[
    'public.add_game_alias(uuid, text, public.game_alias_kind, text, text, text)',
    'public.remove_game_alias(uuid, text)'
  ] loop
    execute format('revoke all on function %s from public, anon, authenticated, service_role, catalog_importer', v_signature);
    execute format('grant execute on function %s to authenticated', v_signature);
  end loop;
end;
$$;
