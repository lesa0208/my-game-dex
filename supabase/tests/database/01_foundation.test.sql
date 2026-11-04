-- M0: extensions, schema and approved enum types.
begin;
create extension if not exists pgtap with schema extensions;
select plan(39);

-- Environment
select ok(current_setting('server_version_num')::int >= 170000, 'PostgreSQL is 17 or newer');

-- Extensions live in `extensions`
select is((select extnamespace::regnamespace::text from pg_extension where extname = 'citext'), 'extensions', 'citext is installed in extensions');
select is((select extnamespace::regnamespace::text from pg_extension where extname = 'pg_trgm'), 'extensions', 'pg_trgm is installed in extensions');
select is((select extnamespace::regnamespace::text from pg_extension where extname = 'pgtap'), 'extensions', 'pgtap is available for tests');

-- Private schema
select has_schema('private', 'private schema exists');
select is((select pg_get_userbyid(nspowner) from pg_namespace where nspname = 'private'), 'postgres', 'postgres owns the private schema');

-- No application objects at M0
select is((select count(*)::int from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname in ('public', 'private') and c.relkind in ('r', 'p', 'v', 'm', 'f', 'S')), 0, 'M0 creates no tables, views or sequences');

-- Approved enums: exact labels, in order
select enum_has_labels('public', 'visibility_level', array['public', 'followers', 'private']);
select enum_has_labels('public', 'follow_status', array['pending', 'accepted']);
select enum_has_labels('public', 'theme_preference', array['system', 'dark', 'light']);
select enum_has_labels('public', 'message_permission', array['everyone', 'followers', 'nobody']);
select enum_has_labels('public', 'staff_role', array['moderator', 'catalog_editor', 'admin']);
select enum_has_labels('public', 'account_status', array['active', 'suspended', 'deactivated']);
select enum_has_labels('public', 'catalog_status', array['unverified', 'under_review', 'published', 'rejected', 'excluded', 'merged']);
select enum_has_labels('public', 'catalog_request_type', array['new_game', 'new_release', 'correction']);
select enum_has_labels('public', 'catalog_review_status', array['open', 'in_review', 'approved', 'changes_requested', 'rejected', 'excluded', 'merged']);
select enum_has_labels('public', 'date_precision', array['day', 'month', 'year', 'unknown']);
select enum_has_labels('public', 'game_kind', array['game', 'compilation', 'expansion']);
select enum_has_labels('public', 'platform_kind', array['console', 'handheld', 'hybrid', 'computer', 'other']);
select enum_has_labels('public', 'media_format', array['cartridge', 'cd', 'dvd', 'gd_rom', 'mini_dvd', 'umd', 'blu_ray', 'game_card', 'floppy', 'other']);
select enum_has_labels('public', 'game_relation_type', array['remake_of', 'remaster_of', 'contains']);
select enum_has_labels('public', 'component_kind', array['insert', 'map', 'artwork', 'other']);
select enum_has_labels('public', 'media_playability', array['playable_from_media', 'download_required', 'unknown']);
select enum_has_labels('public', 'collection_record_status', array['active', 'invalid_preserved']);
select enum_has_labels('public', 'edition_kind', array['standard', 'limited', 'collector', 'reprint', 'bundle', 'promotional', 'other']);
select enum_has_labels('public', 'completeness', array['sealed', 'complete', 'incomplete', 'loose']);
select enum_has_labels('public', 'condition_grade', array['mint', 'near_mint', 'very_good', 'good', 'fair', 'poor', 'not_included']);
select enum_has_labels('public', 'post_kind', array['general', 'pickup', 'showcase', 'review', 'discussion', 'achievement']);
select enum_has_labels('public', 'moderation_status', array['visible', 'hidden', 'removed']);
select enum_has_labels('public', 'notification_type', array['follow', 'follow_request', 'follow_accepted', 'like', 'comment', 'reply', 'mention', 'message', 'achievement', 'moderation', 'catalog_submission', 'catalog_exclusion']);
select enum_has_labels('public', 'conversation_kind', array['direct', 'group']);
select enum_has_labels('public', 'member_role', array['member', 'admin']);
select enum_has_labels('public', 'report_reason', array['spam', 'harassment', 'hate', 'sexual_content', 'violence', 'illegal', 'counterfeit', 'impersonation', 'other']);
select enum_has_labels('public', 'report_status', array['open', 'in_review', 'resolved', 'dismissed']);
select enum_has_labels('public', 'image_kind', array['cover_front', 'cover_back', 'spine', 'media', 'manual', 'screenshot', 'other']);
select enum_has_labels('public', 'license_status', array['unreviewed', 'licensed', 'user_contributed', 'rejected']);
select enum_has_labels('public', 'provider_record_status', array['fetched', 'matched', 'needs_review', 'promoted', 'ignored', 'failed']);

-- Physical-only scope: nothing in the type system can express a digital product,
-- or a collection item without its medium.
select is(
  (select count(*)::int from pg_enum e join pg_type t on t.oid = e.enumtypid join pg_namespace n on n.oid = t.typnamespace
    where n.nspname = 'public' and e.enumlabel ~* '(digital|code_in_box|key_card|entitlement|stream|cloud|parts_only|box_only|manual_only)'),
  0, 'no enum value expresses a digital product or a missing medium'
);
select is(
  (select count(*)::int from pg_type t join pg_namespace n on n.oid = t.typnamespace where n.nspname = 'public' and t.typtype = 'e'),
  30, 'exactly the 30 approved enum types exist'
);

select * from finish();
rollback;
