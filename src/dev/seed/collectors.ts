import type { Collector, SuggestedCollector } from "@/types/user";

function collector(id: string, displayName: string, handle: string): Collector {
  return { id, displayName, handle, avatarUrl: `/seed/avatars/${id}.svg` };
}

export const previewViewer = collector("preview", "Preview Collector", "preview");

export const collectors = {
  mara: collector("mara", "Mara Okafor", "cartridge_mara"),
  kenji: collector("kenji", "Kenji Arai", "saturn_kenji"),
  lucia: collector("lucia", "Lucía Ferrer", "luciaplays"),
  tom: collector("tom", "Tom Reilly", "boxedandbagged"),
  priya: collector("priya", "Priya Nair", "priyadex"),
  jonas: collector("jonas", "Jonas Weber", "crtjonas"),
  amara: collector("amara", "Amara Diallo", "amara_ntsc"),
  sam: collector("sam", "Sam Park", "pixelshelf"),
};

/** Who the preview viewer follows, which drives the Following filter. */
export const followedCollectorIds: ReadonlySet<string> = new Set([
  collectors.mara.id,
  collectors.priya.id,
  collectors.jonas.id,
  collectors.lucia.id,
]);

export const suggestedCollectors: SuggestedCollector[] = [
  { ...collectors.kenji, gamesCataloged: 486, focus: "Saturn and Japanese imports" },
  { ...collectors.amara, gamesCataloged: 312, focus: "PS1 black labels" },
  { ...collectors.sam, gamesCataloged: 158, focus: "Complete-in-box hunting" },
];
