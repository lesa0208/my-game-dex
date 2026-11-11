import { CircleCheck, Info } from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";

import { CatalogCover } from "@/components/games/catalog-cover";
import { Skeleton } from "@/components/ui/skeleton";
import {
  aliasKindLabel,
  componentLabel,
  editionKindLabel,
  formatCatalogDate,
  gameKindLabel,
  languageName,
  regionLabel,
  releaseCountLabel,
} from "@/features/catalog/format";
import type { PickerRelease, ReleasePicker } from "@/features/catalog/types";
import { cn } from "@/lib/utils";

type Selection = { platform: string | null; region: string | null; release: string | null };

/** The page's URL for a selection. The selected release is what "Add to collection" adds (M6c). */
export function gameHref(slug: string, { platform, region, release }: Selection) {
  const params = new URLSearchParams();
  if (platform) params.set("platform", platform);
  if (region) params.set("region", region);
  if (release) params.set("release", release);
  const search = params.toString();
  return search ? `/games/${slug}?${search}` : `/games/${slug}`;
}

const chipClassName =
  "inline-flex min-h-10 items-center gap-1.5 rounded-lg border px-3 text-sm outline-none transition-colors focus-visible:ring-3 focus-visible:ring-ring";

function Chips({ label, items }: { label: string; items: { key: string; text: string; count?: number; href: string; current: boolean }[] }) {
  return (
    <nav aria-label={label}>
      <ul className="flex flex-wrap gap-2">
        {items.map((item) => (
          <li key={item.key}>
            <Link
              href={item.href}
              scroll={false}
              aria-current={item.current ? "page" : undefined}
              className={cn(chipClassName, item.current ? "border-primary bg-primary/10 font-medium text-foreground" : "bg-card text-muted-foreground hover:bg-muted hover:text-foreground")}
            >
              {item.text}
              {item.count !== undefined ? <span className="text-xs text-muted-foreground">{item.count}</span> : null}
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  );
}

/** "Greatest Hits (Reprint)": the kind is added when the name doesn't already say it. */
function editionText(edition: PickerRelease["edition"]) {
  if (!edition) return null;
  const kind = edition.kind && edition.kind !== "standard" ? editionKindLabel(edition.kind) : null;
  if (!edition.name) return kind;
  return kind && !edition.name.toLowerCase().includes(kind.toLowerCase()) ? `${edition.name} (${kind})` : edition.name;
}

/** Each detail the catalog knows about a release, in a fixed order. Unknown ones are left out. */
function details(release: PickerRelease): { key: string; label: string; value: string }[] {
  const rows: { key: string; label: string; value: string | null }[] = [
    { key: "edition", label: "Edition", value: editionText(release.edition) },
    { key: "variant", label: "Variant", value: release.variantName },
    { key: "format", label: "Format", value: release.format ? (release.mediaCount && release.mediaCount > 1 ? `${release.mediaCount} × ${release.format.name}` : release.format.name) : null },
    { key: "packaging", label: "Packaging", value: release.packaging },
    { key: "product_code", label: "Product code", value: release.identifiers.productCode },
    { key: "barcode", label: "Barcode", value: release.identifiers.barcode },
    { key: "date", label: "Released", value: release.releaseDate ? formatCatalogDate(release.releaseDate) : null },
    { key: "markets", label: "Sold in", value: release.markets.length ? release.markets.map((m) => m.name).join(", ") : null },
    { key: "local_title", label: "Title on the box", value: release.localTitle },
    { key: "publisher", label: "Publisher", value: release.publisherName },
    { key: "languages", label: "Languages", value: release.languages ? release.languages.map(languageName).join(", ") : null },
    { key: "components", label: "Includes", value: release.components.length ? release.components.map(componentLabel).join(", ") : null },
    { key: "requirements", label: "Requires", value: release.requirements.length ? release.requirements.map((r) => r.label).join(", ") : null },
    { key: "playability", label: "Playable", value: release.mediaPlayability === "download_required" ? "Needs a download to play" : null },
  ];
  return rows.filter((row): row is { key: string; label: string; value: string } => row.value !== null && row.value !== "");
}

function ReleaseCard({ release, href, selected, varying }: { release: PickerRelease; href: string; selected: boolean; varying: Set<string> }) {
  const rows = details(release);
  return (
    <Link
      href={href}
      scroll={false}
      aria-current={selected ? "true" : undefined}
      className={cn(
        "block rounded-lg border p-3 outline-none transition-colors focus-visible:ring-3 focus-visible:ring-ring",
        selected ? "border-primary bg-primary/10" : "bg-card hover:bg-muted",
      )}
    >
      <div className="flex items-start justify-between gap-2">
        <p className="font-medium">
          {release.platform.shortName} · {regionLabel(release.region)}
        </p>
        {selected ? (
          <span className="inline-flex items-center gap-1 text-xs font-medium text-primary-text">
            <CircleCheck aria-hidden="true" className="size-4" />
            Selected
          </span>
        ) : null}
      </div>
      <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
        {rows.map((row) => (
          <div key={row.key} className="contents">
            <dt className="text-muted-foreground">{row.label}</dt>
            <dd className={cn("min-w-0 wrap-break-word", varying.has(row.key) ? "font-medium text-foreground" : "text-muted-foreground")}>{row.value}</dd>
          </div>
        ))}
      </dl>
    </Link>
  );
}

/**
 * The game, its releases, and the selected one. `renderAdd` renders the add action for
 * the release to add: the selected one, or the only one when there's just one. It's
 * rendered separately because it reads the session, while this view is public.
 * `requestedRelease` is set when the address named a release that isn't shown.
 */
export function ReleasePickerView({
  picker,
  renderAdd,
  requestedRelease = false,
}: {
  picker: ReleasePicker;
  renderAdd?: (release: PickerRelease) => ReactNode;
  requestedRelease?: boolean;
}) {
  const { game, selection } = picker;
  const meta = [game.firstRelease ? formatCatalogDate(game.firstRelease) : null, gameKindLabel(game.kind)].filter(Boolean);
  const selected = picker.releases.find((r) => r.id === selection.releaseId) ?? null;
  const only = !selected && picker.releases.length === 1 ? picker.releases[0] : null;
  const target = selected ?? only;
  // Details that differ between the releases shown are what tell them apart.
  const varying = new Set<string>();
  const shown = picker.releases.map((r) => new Map(details(r).map((row) => [row.key, row.value])));
  for (const key of new Set(shown.flatMap((m) => [...m.keys()]))) {
    if (new Set(shown.map((m) => m.get(key) ?? "")).size > 1) varying.add(key);
  }

  return (
    <article>
      <header className="flex gap-4">
        <CatalogCover className="w-20 md:w-28" />
        <div className="min-w-0">
          <h1 className="text-xl font-semibold tracking-tight text-pretty">{game.title}</h1>
          {meta.length ? <p className="mt-1 text-sm text-muted-foreground">{meta.join(" · ")}</p> : null}
          {game.aliases.length ? (
            <ul aria-label="Other titles" className="mt-2 flex flex-col gap-0.5 text-sm">
              {game.aliases.map((alias) => (
                <li key={`${alias.title}-${alias.languageCode}-${alias.regionCode}`}>
                  <span className="text-muted-foreground">{aliasKindLabel(alias.kind)}: </span>
                  {alias.title}
                  {alias.languageCode ? <span className="text-muted-foreground"> · {languageName(alias.languageCode)}</span> : null}
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      </header>

      <section aria-labelledby="choose-release" className="mt-6 flex flex-col gap-4">
        <h2 id="choose-release" className="text-base font-semibold">
          Choose a release
        </h2>
        {picker.platforms.length > 1 ? (
          <Chips
            label="Platform"
            items={[
              { key: "all", text: "All platforms", href: gameHref(game.slug, { platform: null, region: null, release: null }), current: selection.platform === null },
              ...picker.platforms.map((p) => ({
                key: p.slug,
                text: p.name,
                count: p.releaseCount,
                href: gameHref(game.slug, { platform: p.slug, region: null, release: null }),
                current: selection.platform === p.slug,
              })),
            ]}
          />
        ) : (
          <p className="text-sm text-muted-foreground">
            {picker.platforms[0]?.name} · {releaseCountLabel(picker.platforms[0]?.releaseCount ?? 0)}
          </p>
        )}
        {picker.regions.length > 1 ? (
          <Chips
            label="Region"
            items={[
              { key: "all", text: "All regions", href: gameHref(game.slug, { platform: selection.platform, region: null, release: null }), current: selection.region === null },
              ...picker.regions.map((r) => ({
                key: r.code,
                text: regionLabel(r),
                count: r.releaseCount,
                href: gameHref(game.slug, { platform: selection.platform, region: r.code, release: null }),
                current: selection.region === r.code,
              })),
            ]}
          />
        ) : null}

        {requestedRelease && !selected ? (
          <p className="flex gap-2 rounded-lg border p-3 text-sm text-muted-foreground">
            <Info aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
            That release isn&apos;t available. Choose one of the releases below.
          </p>
        ) : null}

        {target ? (
          <section aria-labelledby="add-release" className="flex flex-col gap-3 rounded-lg border border-primary/40 bg-primary/5 p-3">
            <h3 id="add-release" className="text-sm font-medium">
              {selected ? "Selected" : "The only release"}: {target.platform.shortName} · {regionLabel(target.region)}
              {target.edition?.name ? ` · ${target.edition.name}` : ""}
            </h3>
            {renderAdd ? renderAdd(target) : null}
            {selected ? (
              <p className="text-sm">
                <Link
                  href={gameHref(game.slug, { platform: selection.platform, region: selection.region, release: null })}
                  scroll={false}
                  className="text-primary-text underline underline-offset-4"
                >
                  Clear selection
                </Link>
              </p>
            ) : null}
          </section>
        ) : picker.releases.length > 1 ? (
          <p className="text-sm text-muted-foreground">Choose the release you have to add it to your collection.</p>
        ) : null}

        <ul aria-label="Releases" className="flex flex-col gap-2">
          {picker.releases.map((release) => (
            <li key={release.id}>
              <ReleaseCard
                release={release}
                selected={release.id === selection.releaseId}
                varying={varying}
                href={gameHref(game.slug, { platform: selection.platform, region: selection.region, release: release.id })}
              />
            </li>
          ))}
        </ul>
        <p className="text-sm text-muted-foreground">
          Can&apos;t find your release? Submitting missing games and releases to the catalog is coming in a later update.
        </p>
      </section>
    </article>
  );
}

export function ReleasePickerSkeleton() {
  return (
    <div aria-hidden="true">
      <div className="flex gap-4">
        <Skeleton className="aspect-3/4 w-20 md:w-28" />
        <div className="flex flex-1 flex-col gap-2 pt-1">
          <Skeleton className="h-6 w-2/3" />
          <Skeleton className="h-4 w-1/3" />
        </div>
      </div>
      <div className="mt-6 flex flex-col gap-2">
        <Skeleton className="h-5 w-40" />
        <Skeleton className="h-10 w-full" />
        {Array.from({ length: 3 }, (_, i) => (
          <Skeleton key={i} className="h-28 w-full" />
        ))}
      </div>
    </div>
  );
}
