import { ChevronRight } from "lucide-react";
import Image from "next/image";
import Link from "next/link";
import type { ReactNode } from "react";

import { editionText } from "@/components/catalog/release-picker";
import { shellFor } from "@/components/shelf/media-shells";
import { regionLabel } from "@/features/catalog/format";
import { releaseMoreFacts, releaseSummaryFacts } from "@/features/catalog/release-details";
import type { PickerRelease } from "@/features/catalog/types";
import { type GameImage, LICENSE_LABELS } from "@/features/media/game-images";
import { releaseMedia } from "@/features/shelf/copies";
import { cn } from "@/lib/utils";

// Physical Releases 2.0 (Phase 4A): one physical release as a card. What's on it is what the
// catalog records, and nothing else. The picture is an approved photo of exactly this release,
// credited; else the system's shell, neutral and blank (no title, no generated label art, no
// words), as the hero draws it; else, for a format with no drawn shell, a plain neutral shape.

/**
 * The release's picture, in a square box so cards line up whatever the shell. Decorative
 * when it's a shell or placeholder (the card's text says what it is); a photo has its alt.
 */
export function ReleaseMedia({ release, image }: { release: PickerRelease; image: GameImage | null }) {
  if (image) {
    return (
      <div className="relative flex aspect-square w-full items-center justify-center rounded-lg bg-white/[0.03] p-1.5" data-release-media={`photo:${image.id}`}>
        <Image src={`/${image.file}`} alt={image.alt} width={image.width} height={image.height} sizes="112px" className="h-auto max-h-full w-auto max-w-full object-contain" />
      </div>
    );
  }
  const media = releaseMedia(release);
  if (media) {
    const shell = shellFor(media.kind, media.region);
    return (
      <div aria-hidden="true" className="relative flex aspect-square w-full items-center justify-center rounded-lg bg-white/[0.03] p-2" data-release-media={`shell:${media.kind}:${media.region}`}>
        <div className="relative w-full drop-shadow-[0_8px_10px_rgb(0_0_0/0.5)]">
          <Image src={shell.image} alt="" sizes="112px" draggable={false} className="block h-auto w-full opacity-90 grayscale-[30%]" />
          {/* The label recess, blank: no title, no generated art, no words. */}
          <div
            className="absolute bg-[linear-gradient(160deg,#2a2536,#1a1722)] shadow-[inset_0_0_0_1px_rgb(0_0_0/0.5)]"
            style={{ left: `${shell.label.left}%`, top: `${shell.label.top}%`, width: `${shell.label.width}%`, height: `${shell.label.height}%`, borderRadius: shell.radius }}
          />
        </div>
      </div>
    );
  }
  // No drawn shell for this format (a Famicom cartridge, a DVD case…): a plain shape, never a guessed shell.
  const disc = release.format?.category === "optical_disc";
  return (
    <div aria-hidden="true" className="relative flex aspect-square w-full items-center justify-center rounded-lg bg-white/[0.03] p-2" data-release-media="placeholder">
      <div className={cn("w-[78%] rounded-md border border-white/12 bg-[linear-gradient(160deg,#2a2536,#17141f)] shadow-[0_8px_10px_rgb(0_0_0/0.45)]", disc ? "aspect-[5/7]" : "aspect-[5/4]")} />
    </div>
  );
}

/** The photo's credit, under the facts: what it shows, its source and its terms. */
function PhotoCredit({ image }: { image: GameImage }) {
  return (
    <p className="mt-3 text-xs leading-relaxed text-muted-foreground" data-release-photo-credit="">
      Photo: this release, not necessarily your copy. {image.attribution ? `${image.attribution}. ` : ""}
      {image.source.url ? (
        <a href={image.source.url} className="underline underline-offset-2 hover:text-foreground" rel="noopener noreferrer" target="_blank">
          {image.source.name}
        </a>
      ) : (
        image.source.name
      )}
      {" · "}
      {LICENSE_LABELS[image.license]}: {image.licenseDetail}
    </p>
  );
}

/** The edition to show: none for the standard edition; any other, or a standard one with its own name. */
function shownEdition(edition: PickerRelease["edition"]) {
  if (!edition || (edition.kind === "standard" && (!edition.name || edition.name === "Standard"))) return null;
  return editionText(edition);
}

/** A short name for the release, for its actions' accessible names: "SNES, PAL, UKV". */
export function releaseName(release: PickerRelease) {
  return [release.platform.shortName, regionLabel(release.region), shownEdition(release.edition), release.variantName].filter(Boolean).join(", ");
}

export function ReleaseCard({
  release,
  image,
  addHref,
  owned,
  action,
}: {
  release: PickerRelease;
  image: GameImage | null;
  /** The step-by-step add, with this release already chosen. */
  addHref: string;
  /** The signed-in collector's copies of this release (streamed on its own; empty otherwise). */
  owned?: ReactNode;
  /** Want this release (streamed on its own; empty when signed out). */
  action?: ReactNode;
}) {
  const edition = shownEdition(release.edition);
  const facts = releaseSummaryFacts(release);
  const more = releaseMoreFacts(release);
  const headingId = `release-${release.id}`;
  return (
    <article
      aria-labelledby={headingId}
      className="flex h-full flex-col rounded-xl border border-white/[0.08] bg-white/[0.025] p-3 sm:p-4"
      data-release-card={release.id}
      data-release-platform={release.platform.slug}
      data-release-region={release.region.code}
    >
      <div className="flex gap-3 sm:gap-4">
        <div className="w-[4.5rem] shrink-0 sm:w-24">
          <ReleaseMedia release={release} image={image} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-start justify-between gap-x-3 gap-y-1">
            <h4 id={headingId} className="min-w-0 font-semibold">
              <span className="block text-[0.6875rem] font-medium tracking-[0.12em] text-muted-foreground uppercase">{release.platform.shortName}</span>
              {regionLabel(release.region)}
            </h4>
            {owned ? <div className="empty:hidden">{owned}</div> : null}
          </div>
          {edition || release.variantName ? (
            <ul aria-label="Edition and variant" className="mt-1.5 flex flex-wrap gap-1.5 text-xs">
              {edition ? (
                <li className="rounded-md border border-primary/30 bg-primary/10 px-1.5 py-0.5 text-primary-text" data-release-edition="">
                  {edition}
                </li>
              ) : null}
              {release.variantName ? (
                <li className="rounded-md border border-white/12 bg-white/[0.04] px-1.5 py-0.5" data-release-variant="">
                  Variant: {release.variantName}
                </li>
              ) : null}
            </ul>
          ) : null}
          {release.localTitle ? (
            <p className="mt-1.5 text-xs text-muted-foreground" data-release-local-title="">
              Title on the box: {release.localTitle}
            </p>
          ) : null}
        </div>
      </div>

      {facts.length ? (
        <dl className="mt-3 grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-sm sm:grid-cols-[auto_minmax(0,1fr)_auto_minmax(0,1fr)]" data-release-facts="">
          {facts.map((fact) => (
            <div key={fact.key} className="contents" data-fact={fact.key}>
              <dt className="text-muted-foreground">{fact.label}</dt>
              <dd className={cn("min-w-0 break-words", (fact.key === "product_code" || fact.key === "barcode") && "font-mono text-[0.8125rem] tracking-tight")}>{fact.value}</dd>
            </div>
          ))}
        </dl>
      ) : (
        <p className="mt-3 text-sm text-muted-foreground" data-release-facts="none">
          No further details recorded.
        </p>
      )}

      {image ? <PhotoCredit image={image} /> : null}

      {more.length ? (
        <details className="group mt-3 rounded-lg border border-white/[0.07] bg-black/10" data-release-more="">
          <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between gap-2 rounded-lg px-3 text-sm font-medium outline-none hover:bg-white/[0.03] focus-visible:ring-3 focus-visible:ring-ring [&::-webkit-details-marker]:hidden">
            More details
            <ChevronRight aria-hidden="true" className="size-4 text-muted-foreground transition-transform group-open:rotate-90" />
          </summary>
          <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 px-3 pt-1 pb-3 text-sm">
            {more.map((fact) => (
              <div key={fact.key} className="contents" data-fact={fact.key}>
                <dt className="text-muted-foreground">{fact.label}</dt>
                <dd className="min-w-0 break-words">{fact.value}</dd>
              </div>
            ))}
          </dl>
        </details>
      ) : null}

      <div className="mt-auto flex flex-wrap items-center justify-end gap-2 pt-3">
        {action ? <div className="empty:hidden">{action}</div> : null}
        <Link
          href={addHref}
          scroll={false}
          aria-label={`Add this release to your collection: ${releaseName(release)}`}
          className="inline-flex min-h-9 items-center gap-1 rounded-md px-2.5 text-sm font-medium text-primary-text outline-none hover:bg-primary/10 focus-visible:ring-3 focus-visible:ring-ring max-sm:min-h-11"
          data-release-add=""
        >
          Add this release
          <ChevronRight aria-hidden="true" className="size-4" />
        </Link>
      </div>
    </article>
  );
}
