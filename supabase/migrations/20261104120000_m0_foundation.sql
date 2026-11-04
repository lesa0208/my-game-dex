-- M0 Foundation
--
-- Infrastructure only: extensions, explicit privilege defaults, the private
-- schema, approved enum types and shared helpers. No application tables.
--
-- Design: docs/architecture/security-rls.md#explicit-grants
-- Migrations run as `postgres`, which owns every object this project creates.

-- ---------------------------------------------------------------------------
-- 1. Extensions
-- ---------------------------------------------------------------------------
-- Installed in `extensions`, never `public`, so their objects stay out of the
-- exposed API schema. pgTAP is deliberately absent: tests install it inside a
-- transaction, so it never exists outside a test run.

create extension if not exists citext with schema extensions;
create extension if not exists pg_trgm with schema extensions;

-- ---------------------------------------------------------------------------
-- 2. Explicit privilege defaults
-- ---------------------------------------------------------------------------
-- Supabase's defaults differ between environments and versions, and locally
-- they grant the API roles full access to new objects in `public`. Nothing here
-- relies on them: after this, every privilege is granted deliberately.
--
-- Default privileges apply per creating role. These cover objects created by
-- `postgres`. Roles such as supabase_admin keep their own defaults, so the test
-- suite fails if an application object is owned by any other role.

alter default privileges for role postgres in schema public
  revoke all on tables from anon, authenticated, service_role;
alter default privileges for role postgres in schema public
  revoke all on sequences from anon, authenticated, service_role;
alter default privileges for role postgres in schema public
  revoke all on functions from anon, authenticated, service_role;

-- PostgreSQL grants EXECUTE to PUBLIC on every new function, and a schema-scoped
-- default can't remove a built-in default, so this one has to be role-wide. It
-- affects only functions `postgres` creates from now on. Existing functions and
-- those owned by platform roles (auth, storage, realtime, extensions) don't
-- change. Any `postgres`-owned function in any schema now needs an explicit grant.
alter default privileges for role postgres
  revoke execute on functions from public;

revoke create on schema public from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 3. Private schema
-- ---------------------------------------------------------------------------
-- Not listed in the Data API's exposed schemas. Later steps grant USAGE and
-- EXECUTE on individual helpers where a policy or default needs them.

create schema private;

revoke all on schema private from public, anon, authenticated, service_role;

alter default privileges for role postgres in schema private
  revoke all on tables from anon, authenticated, service_role;
alter default privileges for role postgres in schema private
  revoke all on sequences from anon, authenticated, service_role;
alter default privileges for role postgres in schema private
  revoke all on functions from anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 4. Enum types
-- ---------------------------------------------------------------------------
-- The approved closed sets from docs/architecture/database-schema.md. None of
-- them can express a digital product, or a collection item without its medium.

create type public.visibility_level as enum ('public', 'followers', 'private');
create type public.follow_status as enum ('pending', 'accepted');
create type public.theme_preference as enum ('system', 'dark', 'light');
create type public.message_permission as enum ('everyone', 'followers', 'nobody');
create type public.staff_role as enum ('moderator', 'catalog_editor', 'admin');
create type public.account_status as enum ('active', 'suspended', 'deactivated');
create type public.catalog_status as enum ('unverified', 'under_review', 'published', 'rejected', 'excluded', 'merged');
create type public.catalog_request_type as enum ('new_game', 'new_release', 'correction');
create type public.catalog_review_status as enum ('open', 'in_review', 'approved', 'changes_requested', 'rejected', 'excluded', 'merged');
create type public.date_precision as enum ('day', 'month', 'year', 'unknown');
create type public.game_kind as enum ('game', 'compilation', 'expansion');
create type public.platform_kind as enum ('console', 'handheld', 'hybrid', 'computer', 'other');
create type public.media_format as enum ('cartridge', 'cd', 'dvd', 'gd_rom', 'mini_dvd', 'umd', 'blu_ray', 'game_card', 'floppy', 'other');
create type public.game_relation_type as enum ('remake_of', 'remaster_of', 'contains');
create type public.component_kind as enum ('insert', 'map', 'artwork', 'other');
create type public.media_playability as enum ('playable_from_media', 'download_required', 'unknown');
create type public.collection_record_status as enum ('active', 'invalid_preserved');
create type public.edition_kind as enum ('standard', 'limited', 'collector', 'reprint', 'bundle', 'promotional', 'other');
create type public.completeness as enum ('sealed', 'complete', 'incomplete', 'loose');
create type public.condition_grade as enum ('mint', 'near_mint', 'very_good', 'good', 'fair', 'poor', 'not_included');
create type public.post_kind as enum ('general', 'pickup', 'showcase', 'review', 'discussion', 'achievement');
create type public.moderation_status as enum ('visible', 'hidden', 'removed');
create type public.notification_type as enum ('follow', 'follow_request', 'follow_accepted', 'like', 'comment', 'reply', 'mention', 'message', 'achievement', 'moderation', 'catalog_submission', 'catalog_exclusion');
create type public.conversation_kind as enum ('direct', 'group');
create type public.member_role as enum ('member', 'admin');
create type public.report_reason as enum ('spam', 'harassment', 'hate', 'sexual_content', 'violence', 'illegal', 'counterfeit', 'impersonation', 'other');
create type public.report_status as enum ('open', 'in_review', 'resolved', 'dismissed');
create type public.image_kind as enum ('cover_front', 'cover_back', 'spine', 'media', 'manual', 'screenshot', 'other');
create type public.license_status as enum ('unreviewed', 'licensed', 'user_contributed', 'rejected');
create type public.provider_record_status as enum ('fetched', 'matched', 'needs_review', 'promoted', 'ignored', 'failed');

-- ---------------------------------------------------------------------------
-- 5. Shared helpers
-- ---------------------------------------------------------------------------

-- Trigger function. Firing a trigger doesn't check EXECUTE for the acting role,
-- so it needs no grants, and clients can't forge updated_at.
create function private.set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := pg_catalog.now();
  return new;
end;
$$;

-- RFC 9562 UUID version 7. PostgreSQL 17 has no built-in uuidv7(), and the
-- pg_uuidv7 extension isn't available here, so this works on any version.
--
-- The first 48 bits are Unix milliseconds. IDs from different milliseconds sort
-- by time. Within one millisecond the order is random, so never assume strict
-- monotonic ordering. Tables that need a total order must also sort on another
-- column.
--
-- A column default using this needs EXECUTE for the inserting role, granted when
-- that table is created.
create function private.uuid_v7()
returns uuid
language sql
volatile
parallel safe
set search_path = ''
as $$
  select pg_catalog.encode(
    pg_catalog.set_bit(
      pg_catalog.set_bit(
        overlay(
          pg_catalog.uuid_send(pg_catalog.gen_random_uuid())
          placing substring(
            pg_catalog.int8send((extract(epoch from pg_catalog.clock_timestamp()) * 1000)::bigint)
            from 3
          )
          from 1 for 6
        ),
        52, 1
      ),
      53, 1
    ),
    'hex'
  )::uuid
$$;

revoke all on function private.set_updated_at() from public, anon, authenticated, service_role;
revoke all on function private.uuid_v7() from public, anon, authenticated, service_role;
