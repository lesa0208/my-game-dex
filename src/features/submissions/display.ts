import type { SubmissionValues } from "@/components/submissions/submission-form";

import type { SubmissionDetails } from "./queries";

/** "Starfall Odyssey (SNES · PAL · Limited)", from what was submitted. */
export function submissionName(details: Pick<SubmissionDetails, "title" | "platform" | "region" | "edition_name">) {
  const region = details.region.code === "unknown" ? "Region unknown" : details.region.label;
  const line = [details.platform.short_name, region, details.edition_name].filter(Boolean).join(" · ");
  return `${details.title} (${line})`;
}

/** The edit form's starting values: exactly what was submitted, nothing filled in. */
export function formValues(details: SubmissionDetails, note: string | null): SubmissionValues {
  return {
    title: details.title,
    gameKind: details.game_kind,
    firstReleaseYear: details.first_release_year ? String(details.first_release_year) : "",
    platform: details.platform.slug,
    mediaFormat: details.format.code,
    region: details.region.code,
    editionName: details.edition_name ?? "",
    editionKind: details.edition_kind ?? "",
    variantName: details.variant_name ?? "",
    productCode: details.product_code ?? "",
    barcode: details.barcode ?? "",
    localTitle: details.local_title ?? "",
    publisherName: details.publisher_name ?? "",
    mediaCount: details.media_count ? String(details.media_count) : "",
    packaging: details.packaging ?? "",
    releaseYear: details.release_date ? details.release_date.slice(0, 4) : "",
    pieces: details.components.map((c) => ({ kind: c.kind, label: c.label, quantity: String(c.quantity) })),
    note: note ?? "",
  };
}

const whenFormat = new Intl.DateTimeFormat("en", { month: "long", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: "UTC" });

/** "November 13, 2:05 PM UTC". */
export function formatWhen(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : `${whenFormat.format(date)} UTC`;
}
