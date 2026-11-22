-- ROLLBACK for 20261207100000_m12w1_wishlist.sql (M12 W1 Physical Wishlist).
--
-- Kept outside supabase/migrations so that the CLI never applies it. To roll back, run
-- it as a forward migration in one transaction (copy it into supabase/migrations with
-- a later timestamp, or run it with psql -1 as the migration role), then remove the
-- wishlist from the app. A refusal changes nothing.
--
-- Wishlists are collectors' own data and nothing else holds them, so this refuses
-- while any entry exists. To discard them knowingly, export them first and set, in the
-- same transaction:
--
--   set local mgd.discard_wishlists = 'yes';
--
-- It removes everything the migration made: the six client functions, the helpers,
-- the triggers' functions, the policy and the table with its indexes. No other object
-- was changed by the migration, so nothing else needs restoring. Re-applying the
-- migration afterwards is a new forward migration.

do $$
declare
  v_entries bigint;
begin
  if to_regclass('public.wishlist_items') is null then
    raise exception 'wishlist rollback: public.wishlist_items doesn''t exist; nothing to roll back';
  end if;
  select count(*) into v_entries from public.wishlist_items;
  if v_entries > 0 and coalesce(current_setting('mgd.discard_wishlists', true), '') <> 'yes' then
    raise exception 'wishlist rollback refused: % wishlist entries exist. Export them, then set mgd.discard_wishlists = ''yes'' to discard them.', v_entries;
  end if;
  if v_entries > 0 then
    raise notice 'wishlist rollback: discarding % wishlist entries', v_entries;
  end if;
end;
$$;

revoke all on function public.add_wishlist_item(uuid, jsonb, jsonb), public.update_wishlist_item(uuid, jsonb), public.remove_wishlist_item(uuid),
  public.get_my_wishlist(text, text, text, integer, text, integer, text), public.get_my_wishlist_for_game(uuid), public.get_my_wishlist_item(uuid)
  from public, anon, authenticated, service_role;
drop function public.add_wishlist_item(uuid, jsonb, jsonb);
drop function public.update_wishlist_item(uuid, jsonb);
drop function public.remove_wishlist_item(uuid);
drop function public.get_my_wishlist(text, text, text, integer, text, integer, text);
drop function public.get_my_wishlist_for_game(uuid);
drop function public.get_my_wishlist_item(uuid);

drop function private.wishlist_json(uuid, uuid[]);
drop function private.wishlist_entries(uuid, uuid[], boolean);
drop function private.parse_wishlist_details(jsonb, text[]);
drop function private.lock_wishlist_target(uuid, uuid, uuid, text);
drop function private.parse_wishlist_target(jsonb);
drop function private.final_game(uuid);
drop function private.final_release(uuid);
drop function private.completeness_rank(public.completeness);

-- The table takes its policy, indexes and triggers with it; then the trigger functions.
drop table public.wishlist_items;
drop function private.check_new_wishlist_item();
drop function private.guard_wishlist_item_update();
