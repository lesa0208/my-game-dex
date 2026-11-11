-- M6d follow-up: editing a copy's pieces keeps its records of pieces the release no
-- longer lists, and those records are removed only when the owner asks.
--
-- Design: docs/architecture/security-rls.md#collection-system
-- Replaces public.update_collection_item with the same signature, still SECURITY
-- INVOKER with an empty search_path. CREATE OR REPLACE keeps its owner and grants
-- (execute for authenticated only). Every other rule is unchanged: the caller, an
-- active account, the copy's owner, a preserved copy, the listed-piece trigger, the
-- owner-only policies, and one transaction for the whole change.
--
-- Two changes:
-- 1. "components" replaces the recorded pieces the release lists now, and leaves the
--    records of pieces it no longer lists. Before, it replaced every record, and an
--    unlisted piece can't be recorded again, so an edit lost them.
-- 2. "remove_components" ([{kind, label}]) removes records of pieces the release no
--    longer lists, by their exact identity. Each must be recorded for this copy, appear
--    once, and not be listed (a listed piece is changed through "components"). Anything
--    else refuses the whole change.

create or replace function public.update_collection_item(p_item uuid, p_changes jsonb)
returns boolean
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_me uuid := (select auth.uid());
  v_item public.collection_items;
  v_private public.collection_item_private;
  v_has_private boolean;
  v_acquired date;
  v_price numeric(14, 4);
  v_currency text;
  v_notes text;
  v_location text;
begin
  if v_me is null then
    raise exception 'not permitted' using errcode = '42501';
  end if;
  if p_changes is null or pg_catalog.jsonb_typeof(p_changes) <> 'object'
     or exists (select 1 from pg_catalog.jsonb_object_keys(p_changes) k
                where k <> all (array['completeness', 'overall_condition', 'box_condition', 'media_condition', 'manual_condition',
                                      'acquired_on', 'purchase_price', 'currency', 'notes', 'storage_location', 'components',
                                      'remove_components'])) then
    raise exception 'invalid details' using errcode = '22023';
  end if;

  -- First, because locking the row below also applies the update policy, which needs
  -- an active account.
  if not coalesce((select a.is_active from public.get_my_account() a), false) then
    raise exception 'account not active' using errcode = 'P0001';
  end if;
  select * into v_item from public.collection_items c where c.id = p_item and c.owner_id = v_me for update;
  if not found then
    raise exception 'item unavailable' using errcode = 'P0001';
  end if;
  if v_item.record_status = 'invalid_preserved' then
    raise exception 'item preserved' using errcode = 'P0001';
  end if;

  begin
    update public.collection_items c set
      completeness = case when p_changes ? 'completeness' then (p_changes ->> 'completeness')::public.completeness else c.completeness end,
      overall_condition = case when p_changes ? 'overall_condition' then (p_changes ->> 'overall_condition')::public.condition_grade else c.overall_condition end,
      box_condition = case when p_changes ? 'box_condition' then (p_changes ->> 'box_condition')::public.condition_grade else c.box_condition end,
      media_condition = case when p_changes ? 'media_condition' then (p_changes ->> 'media_condition')::public.condition_grade else c.media_condition end,
      manual_condition = case when p_changes ? 'manual_condition' then (p_changes ->> 'manual_condition')::public.condition_grade else c.manual_condition end
    where c.id = p_item;

    if p_changes ?| array['acquired_on', 'purchase_price', 'currency', 'notes', 'storage_location'] then
      select * into v_private from public.collection_item_private p where p.item_id = p_item;
      v_has_private := found;
      v_acquired := case when p_changes ? 'acquired_on' then (p_changes ->> 'acquired_on')::date else v_private.acquired_on end;
      if p_changes ? 'purchase_price' and p_changes ->> 'purchase_price' !~ '^[0-9]{1,10}(\.[0-9]{1,4})?$' then
        raise exception using errcode = '22P02';
      end if;
      v_price := case when p_changes ? 'purchase_price' then (p_changes ->> 'purchase_price')::numeric(14, 4) else v_private.purchase_price end;
      v_currency := case when p_changes ? 'currency' then p_changes ->> 'currency' else v_private.currency end;
      v_notes := case when p_changes ? 'notes' then nullif(p_changes ->> 'notes', '') else v_private.notes end;
      v_location := case when p_changes ? 'storage_location' then nullif(pg_catalog.btrim(p_changes ->> 'storage_location'), '') else v_private.storage_location end;

      if num_nonnulls(v_acquired, v_price, v_currency, v_notes, v_location) = 0 then
        delete from public.collection_item_private p where p.item_id = p_item;
      elsif v_has_private then
        update public.collection_item_private p
        set acquired_on = v_acquired, purchase_price = v_price, currency = v_currency, notes = v_notes, storage_location = v_location
        where p.item_id = p_item;
      else
        insert into public.collection_item_private (item_id, owner_id, acquired_on, purchase_price, currency, notes, storage_location)
        values (p_item, v_me, v_acquired, v_price, v_currency, v_notes, v_location);
      end if;
    end if;

    if p_changes ? 'remove_components' then
      -- A non-empty list of {kind, label} objects, each with exactly those two text keys.
      if pg_catalog.jsonb_typeof(p_changes -> 'remove_components') <> 'array'
         or pg_catalog.jsonb_array_length(p_changes -> 'remove_components') not between 1 and 60
         or exists (select 1 from pg_catalog.jsonb_array_elements(p_changes -> 'remove_components') e
                    where pg_catalog.jsonb_typeof(e) <> 'object'
                       or (select count(*) from pg_catalog.jsonb_object_keys(e)) <> 2
                       or pg_catalog.jsonb_typeof(e -> 'kind') is distinct from 'string'
                       or pg_catalog.jsonb_typeof(e -> 'label') is distinct from 'string') then
        raise exception using errcode = '22P02';
      end if;
      -- Each piece once. The kind's cast fails for an unknown kind.
      if (select count(*) from pg_catalog.jsonb_to_recordset(p_changes -> 'remove_components') as x(kind public.component_kind, label text))
         <> (select count(distinct (x.kind, x.label)) from pg_catalog.jsonb_to_recordset(p_changes -> 'remove_components') as x(kind public.component_kind, label text)) then
        raise exception using errcode = '22P02';
      end if;
      -- A piece the release lists is changed through "components", never removed here.
      if exists (select 1 from pg_catalog.jsonb_to_recordset(p_changes -> 'remove_components') as x(kind public.component_kind, label text)
                 join public.release_components rc on rc.release_id = v_item.release_id and rc.kind = x.kind and rc.label = x.label) then
        raise exception using errcode = '22P02';
      end if;
      -- Each must be a record of this copy's.
      if exists (select 1 from pg_catalog.jsonb_to_recordset(p_changes -> 'remove_components') as x(kind public.component_kind, label text)
                 where not exists (select 1 from public.collection_item_components c
                                   where c.item_id = p_item and c.owner_id = v_me and c.kind = x.kind and c.label = x.label)) then
        raise exception 'component unavailable' using errcode = 'P0001';
      end if;
      delete from public.collection_item_components c
      using pg_catalog.jsonb_to_recordset(p_changes -> 'remove_components') as x(kind public.component_kind, label text)
      where c.item_id = p_item and c.owner_id = v_me and c.kind = x.kind and c.label = x.label;
    end if;

    if p_changes ? 'components' then
      if pg_catalog.jsonb_typeof(p_changes -> 'components') <> 'array' or pg_catalog.jsonb_array_length(p_changes -> 'components') > 60
         or exists (select 1 from pg_catalog.jsonb_array_elements(p_changes -> 'components') e
                    where pg_catalog.jsonb_typeof(e) <> 'object'
                       or exists (select 1 from pg_catalog.jsonb_object_keys(e) k where k <> all (array['kind', 'label', 'condition']))) then
        raise exception using errcode = '22P02';
      end if;
      -- Only the records of pieces the release lists now are replaced. Records of pieces
      -- it no longer lists stay until "remove_components" names them.
      delete from public.collection_item_components c
      where c.item_id = p_item
        and exists (select 1 from public.release_components rc
                    where rc.release_id = v_item.release_id and rc.kind = c.kind and rc.label = c.label);
      insert into public.collection_item_components (item_id, owner_id, kind, label, condition)
      select p_item, v_me, x.kind, x.label, x.condition
      from pg_catalog.jsonb_to_recordset(p_changes -> 'components') as x(kind public.component_kind, label text, condition public.condition_grade);
    end if;
  exception
    when invalid_text_representation or invalid_datetime_format or datetime_field_overflow or check_violation
      or numeric_value_out_of_range or not_null_violation or unique_violation or string_data_right_truncation then
      raise exception 'invalid details' using errcode = '22023';
  end;
  return true;
end;
$$;
