import { componentLabel, formatCatalogDate, languageName } from "./format";
import { packagingLabel } from "./packaging";
import type { PickerRelease } from "./types";

// Physical Releases 2.0: what a release card says, as the catalog records it. Each list keeps a
// fixed order and leaves an unrecorded detail out: nothing is guessed, filled in or shown as a
// placeholder value.

export type ReleaseFact = { key: string; label: string; value: string };

const kept = (rows: { key: string; label: string; value: string | null }[]) => rows.filter((row): row is ReleaseFact => row.value !== null && row.value.trim() !== "");

/** "3 × CD-ROM", "North American SNES Game Pak". */
export function releaseFormatText(release: Pick<PickerRelease, "format" | "mediaCount">) {
  if (!release.format) return null;
  return release.mediaCount && release.mediaCount > 1 ? `${release.mediaCount} × ${release.format.name}` : release.format.name;
}

/** The card's own facts, always shown: the physical item and how it's identified. */
export function releaseSummaryFacts(release: PickerRelease): ReleaseFact[] {
  return kept([
    { key: "format", label: "Format", value: releaseFormatText(release) },
    { key: "packaging", label: "Packaging", value: packagingLabel(release.packagingCode, release.packaging) },
    { key: "product_code", label: "Product code", value: release.identifiers.productCode },
    { key: "barcode", label: "Barcode", value: release.identifiers.barcode },
    { key: "date", label: "Released", value: release.releaseDate ? formatCatalogDate(release.releaseDate) : null },
    { key: "publisher", label: "Publisher", value: release.publisherName },
  ]);
}

/** The rest, behind "More details": where it was sold, what's in the box, what it needs. */
export function releaseMoreFacts(release: PickerRelease): ReleaseFact[] {
  return kept([
    { key: "markets", label: "Sold in", value: release.markets.length ? release.markets.map((m) => m.name).join(", ") : null },
    { key: "languages", label: "Languages", value: release.languages?.length ? release.languages.map(languageName).join(", ") : null },
    { key: "components", label: "Includes", value: release.components.length ? release.components.map(componentLabel).join(", ") : null },
    {
      key: "requirements",
      label: "Requires",
      value: release.requirements.length ? release.requirements.map((r) => (r.note ? `${r.label} (${r.note})` : r.label)).join(", ") : null,
    },
    { key: "ratings", label: "Age ratings", value: release.ratingLabels?.length ? release.ratingLabels.join(", ") : null },
    { key: "playability", label: "Playable", value: release.mediaPlayability === "download_required" ? "Needs a download to play" : null },
  ]);
}
