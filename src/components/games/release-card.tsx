import { Plus } from "lucide-react";
import Image from "next/image";
import Link from "next/link";
import type { ReactNode } from "react";

import { editionText } from "@/components/catalog/release-picker";
import { ConsoleArt } from "@/components/shelf/console-art";
import { shellFor } from "@/components/shelf/media-shells";
import { regionLabel } from "@/features/catalog/format";
import { releaseMoreFacts, releaseSummaryFacts } from "@/features/catalog/release-details";
import type { PickerRelease } from "@/features/catalog/types";
import { type GameImage, LICENSE_LABELS } from "@/features/media/game-images";
import { consoleFor, releaseMedia } from "@/features/shelf/copies";
import { cn } from "@/lib/utils";

// Physical Releases 2.0 (Phase 4A): one physical release as a card. What's on it is what the
// catalog records, and nothing else. The physical object leads: an approved photo of exactly
// this release, credited; else the system's shell, neutral and blank (no title, no generated
// label art, no words), as the hero draws it; else, for a format with no drawn shell, a plain
// neutral shape. Then what identifies the release: platform, region, edition or variant and
// product code; then the rest of its facts.

/** The stage the object stands in: every card's is the same shape, so a grid lines up. */
const STAGE = { width: 5, height: 4 };

/**
 * The object's width as a share of the stage, so it fits the stage at its own proportions
 * (a wide SNES cartridge fills the width, a tall NES one the height). Never stretched.
 */
function fitWidth(aspect: number) {
  return `${Math.min(1, (aspect * STAGE.height) / STAGE.width) * 100}%`;
}

/**
 * The release's physical object, on its stage. Decorative when it's a shell or plain shape
 * (the card's text says what it is); a photo has its alt text.
 */
export function ReleaseMedia({ release, image }: { release: PickerRelease; image: GameImage | null }) {
  const stage = "relative flex aspect-[5/4] w-full items-center justify-center";
  if (image) {
    return (
      <div className={stage} data-release-media={`photo:${image.id}`}>
        <Image
          src={`/${image.file}`}
          alt={image.alt}
          width={image.width}
          height={image.height}
          sizes="(min-width: 640px) 13rem, 60vw"
          className="h-auto drop-shadow-[0_14px_18px_rgb(0_0_0/0.55)]"
          style={{ width: fitWidth(image.width / image.height) }}
        />
      </div>
    );
  }
  const media = releaseMedia(release);
  if (media) {
    const shell = shellFor(media.kind, media.region);
    return (
      <div aria-hidden="true" className={stage} data-release-media={`shell:${media.kind}:${media.region}`}>
        <span className="absolute inset-x-[18%] bottom-[6%] h-3 rounded-[50%] bg-black/60 blur-md" />
        <div className="relative drop-shadow-[0_14px_18px_rgb(0_0_0/0.55)]" style={{ width: fitWidth(shell.image.width / shell.image.height) }}>
          <Image src={shell.image} alt="" sizes="(min-width: 640px) 13rem, 60vw" draggable={false} className="block h-auto w-full opacity-90 grayscale-[30%]" />
          {/* The label recess, blank: no title, no generated art, no words. */}
          <div
            className="absolute bg-[linear-gradient(160deg,#2a2536,#1a1722)] shadow-[inset_0_0_0_1px_rgb(0_0_0/0.5)]"
            style={{ left: `${shell.label.left}%`, top: `${shell.label.top}%`, width: `${shell.label.width}%`, height: `${shell.label.height}%`, borderRadius: shell.radius }}
          />
        </div>
      </div>
    );
  }
  // No drawn shell for this format (a Famicom cartridge, a DVD case…): a plain shape of the
  // format's kind, never a guessed shell.
  const disc = release.format?.category === "optical_disc";
  return (
    <div aria-hidden="true" className={stage} data-release-media="placeholder">
      <span className="absolute inset-x-[22%] bottom-[6%] h-3 rounded-[50%] bg-black/60 blur-md" />
      <div
        className="relative rounded-lg border border-white/12 bg-[linear-gradient(160deg,#2f2a3c,#17141f)] shadow-[0_14px_18px_rgb(0_0_0/0.5)]"
        style={{ width: fitWidth(disc ? 5 / 7 : 5 / 4), aspectRatio: disc ? "5 / 7" : "5 / 4" }}
      />
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
  /** The step-by-step add of a copy, with this release already chosen. */
  addHref: string;
  /** The signed-in collector's copies of this release (streamed on its own; empty otherwise). */
  owned?: ReactNode;
  /** Want this release (streamed on its own; empty when signed out). */
  action?: ReactNode;
}) {
  const edition = shownEdition(release.edition);
  const productCode = release.identifiers.productCode;
  // The product code has its own place under the heading; the other facts are listed below.
  const facts = releaseSummaryFacts(release).filter((fact) => fact.key !== "product_code");
  const more = releaseMoreFacts(release);
  const consoleKind = consoleFor(release.platform.slug);
  const headingId = `release-${release.id}`;
  return (
    <article
      aria-labelledby={headingId}
      className="flex h-full flex-col overflow-hidden rounded-2xl border border-white/[0.09] bg-[linear-gradient(180deg,rgb(255_255_255/0.04),rgb(255_255_255/0.015))] shadow-[0_18px_40px_-28px_rgb(0_0_0/0.9)]"
      data-release-card={release.id}
      data-release-platform={release.platform.slug}
      data-release-region={release.region.code}
    >
      <div className="flex flex-1 flex-col sm:flex-row">
        {/* The physical object, on a stage of the page's violet light. */}
        <div className="relative shrink-0 border-b border-white/[0.06] bg-[radial-gradient(ellipse_at_50%_40%,rgb(167_139_250/0.16),transparent_70%),linear-gradient(180deg,#1b1724,#131019)] px-10 py-5 sm:flex sm:w-48 sm:items-center sm:border-r sm:border-b-0 sm:px-5 sm:py-6 xl:w-56">
          <div className="mx-auto w-full max-w-[13rem] sm:max-w-none">
            <ReleaseMedia release={release} image={image} />
          </div>
        </div>

        <div className="flex min-w-0 flex-1 flex-col p-4 sm:p-5">
          <div className="flex flex-wrap items-start justify-between gap-x-3 gap-y-2">
            <h4 id={headingId} className="min-w-0">
              <span className="flex items-center gap-1.5 text-xs font-medium tracking-[0.12em] text-muted-foreground uppercase">
                {consoleKind ? <ConsoleArt kind={consoleKind} sizes="24px" className="h-4 w-5 shrink-0" /> : null}
                {release.platform.shortName}
              </span>
              <span className="mt-0.5 block text-xl leading-tight font-semibold tracking-tight">{regionLabel(release.region)}</span>
            </h4>
            {owned ? <div className="shrink-0 empty:hidden">{owned}</div> : null}
          </div>

          {edition || release.variantName ? (
            <ul aria-label="Edition and variant" className="mt-2.5 flex flex-wrap gap-1.5 text-xs font-medium">
              {edition ? (
                <li className="rounded-full border border-primary/35 bg-primary/12 px-2.5 py-1 text-primary-text" data-release-edition="">
                  {edition}
                </li>
              ) : null}
              {release.variantName ? (
                <li className="rounded-full border border-amber-300/30 bg-amber-300/10 px-2.5 py-1 text-amber-100" data-release-variant="">
                  Variant: {release.variantName}
                </li>
              ) : null}
            </ul>
          ) : null}

          {productCode ? (
            <p className="mt-3 flex flex-wrap items-baseline gap-x-2 gap-y-0.5" data-release-product-code="">
              <span className="text-xs text-muted-foreground">Product code</span>
              <span className="rounded-md border border-white/12 bg-black/25 px-2 py-0.5 font-mono text-sm tracking-tight">{productCode}</span>
            </p>
          ) : null}

          {release.localTitle ? (
            <p className="mt-2 text-sm text-muted-foreground" data-release-local-title="">
              Title on the box: <span className="text-foreground">{release.localTitle}</span>
            </p>
          ) : null}

          {facts.length ? (
            <dl className="mt-4 grid grid-cols-2 gap-x-4 gap-y-3 border-t border-white/[0.06] pt-4 text-sm" data-release-facts="">
              {facts.map((fact) => (
                <div key={fact.key} className={cn("min-w-0", fact.key === "format" && "col-span-2")} data-fact={fact.key}>
                  <dt className="text-xs text-muted-foreground">{fact.label}</dt>
                  <dd className={cn("mt-0.5 break-words", fact.key === "barcode" && "font-mono text-[0.8125rem] tracking-tight")}>{fact.value}</dd>
                </div>
              ))}
            </dl>
          ) : (
            <p className="mt-4 border-t border-white/[0.06] pt-4 text-sm text-muted-foreground" data-release-facts="none">
              No further details recorded.
            </p>
          )}

          {image ? <PhotoCredit image={image} /> : null}

          {more.length ? (
            <details className="group mt-4 rounded-lg border border-white/[0.07] bg-black/15" data-release-more="">
              <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between gap-2 rounded-lg px-3 text-sm font-medium outline-none hover:bg-white/[0.03] focus-visible:ring-3 focus-visible:ring-ring [&::-webkit-details-marker]:hidden">
                More details
                <Plus aria-hidden="true" className="size-4 text-muted-foreground transition-transform group-open:rotate-45" />
              </summary>
              <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1.5 px-3 pt-1 pb-3 text-sm">
                {more.map((fact) => (
                  <div key={fact.key} className="contents" data-fact={fact.key}>
                    <dt className="text-muted-foreground">{fact.label}</dt>
                    <dd className="min-w-0 break-words">{fact.value}</dd>
                  </div>
                ))}
              </dl>
            </details>
          ) : null}
        </div>
      </div>

      {/* The collector's actions: a copy of this release for their collection, or a wish for it. */}
      <div className="flex flex-wrap items-center justify-end gap-2 border-t border-white/[0.06] bg-black/15 px-4 py-3 sm:px-5" data-release-actions="">
        {action ? <div className="empty:hidden [&_button]:h-10 [&_button]:px-3 [&_button]:text-sm max-sm:[&_button]:h-11 [&_form]:items-stretch">{action}</div> : null}
        <Link
          href={addHref}
          scroll={false}
          className="inline-flex h-10 items-center gap-1.5 rounded-lg bg-primary-solid px-3.5 text-sm font-medium text-primary-solid-foreground outline-none hover:bg-primary-solid/90 focus-visible:ring-3 focus-visible:ring-ring max-sm:h-11"
          data-release-add=""
        >
          <Plus aria-hidden="true" className="size-4" />
          Add to collection
          <span className="sr-only">, a copy of this release: {releaseName(release)}</span>
        </Link>
      </div>
    </article>
  );
}
