-- M5a Catalog: Neo Geo MVS as its own platform and media format.
--
-- Approved by the product owner for the initial catalog. MVS cartridges are physical
-- game media and in scope. Arcade cabinets, MVS boards and other hardware are not,
-- because the catalog never records hardware (D4, Q10). AES and MVS cartridges are
-- physically different and not interchangeable, so each has its own platform and
-- format, and a release can't use the other's format.

insert into public.media_formats (code, category, name, description, position) values
  ('neo-geo-mvs-cartridge', 'cartridge', 'Neo Geo MVS cartridge',
   'The arcade cartridge format. Physically different from Neo Geo AES cartridges, and not interchangeable with them.', 70);

insert into public.platforms (slug, name, short_name, manufacturer, family, kind, released_year, notes) values
  ('neo-geo-mvs', 'Neo Geo MVS', 'MVS', 'SNK', 'Neo Geo', 'other', 1990,
   'Arcade cartridges only. Cabinets, boards and other hardware are out of scope. Separate from Neo Geo AES, whose cartridges are physically different.');

insert into public.platform_media_formats (platform_id, media_format_code)
select p.id, 'neo-geo-mvs-cartridge' from public.platforms p where p.slug = 'neo-geo-mvs';

-- The AES note said MVS was out of scope, which is no longer true.
update public.platforms
set notes = replace(notes, 'Home system only: arcade MVS is out of scope.', 'Home system. Its cartridges differ physically from the separate Neo Geo MVS platform.')
where slug = 'neo-geo-aes';
