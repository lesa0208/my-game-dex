-- M11b-1a: physical cartridge formats for NES/Famicom and SNES/Super Famicom.
--
-- Design: docs/architecture/physical-catalog-m11b.md (sections 4 and 6), approved by the
-- product owner on 2026-11-18 with these identifiers. Famicom and Super Famicom stay on
-- the nes and snes platforms (ADR-031); their physical differences become media formats
-- (ADR-032), which a release's format must match through the existing composite foreign
-- key, and which the merge guard and verification already treat as identity.
--
-- The codes are stable catalog identifiers: once used, they are never renamed or reused.
-- rom-cartridge stays valid on both platforms for records whose shape hasn't been
-- classified. No release is changed here.
--
-- Importer effect (intended): a platform with more than one format never gets an
-- automatic format, so new nes and snes release entries are held for an editor as
-- "format unknown". The shape is never inferred from a title, a ROM name or a region tag.

insert into public.media_formats (code, category, name, description, position) values
  ('famicom-cartridge', 'cartridge', 'Famicom Cartridge',
   '60-pin Family Computer cartridge. Not interchangeable with the 72-pin NES Game Pak.', 80),
  ('nes-game-pak', 'cartridge', 'NES Game Pak',
   '72-pin NES cartridge with a lockout chip. NTSC and PAL share the shell; the lockout region belongs to the release.', 81),
  ('snes-cartridge-jp-pal', 'cartridge', 'Super Famicom / PAL SNES Cartridge',
   'The narrow Super Famicom and PAL SNES shell with a curved front. The region lock belongs to the release.', 82),
  ('snes-game-pak-na', 'cartridge', 'North American SNES Game Pak',
   'The North American SNES shell, with a rectangular bottom and grooves for the console''s tabs.', 83);

insert into public.platform_media_formats (platform_id, media_format_code)
select p.id, v.format
from (values
  ('nes', 'famicom-cartridge'),
  ('nes', 'nes-game-pak'),
  ('snes', 'snes-cartridge-jp-pal'),
  ('snes', 'snes-game-pak-na')
) as v (slug, format)
join public.platforms p on p.slug = v.slug;

-- Fail the migration rather than leave a format unlinked.
do $$
begin
  if (select count(*) from public.platform_media_formats
      where media_format_code in ('famicom-cartridge', 'nes-game-pak', 'snes-cartridge-jp-pal', 'snes-game-pak-na')) <> 4 then
    raise exception 'M11b-1a: expected four platform links for the new cartridge formats';
  end if;
end;
$$;
