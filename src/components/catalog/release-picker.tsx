import { CircleCheck, Info } from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";

import { CatalogCover } from "@/components/games/catalog-cover";
import { packagingLabel } from "@/features/catalog/packaging";
import { Skeleton } from "@/components/ui/skeleton";
import {
  aliasKindLabel,
  componentLabel,
  editionKindLabel,
  formatCatalogDate,
  gameKindLabel,
  languageName,
  regionLabel,
} from "@/features/catalog/format";
import type { PickerRelease, ReleasePicker } from "@/features/catalog/types";
import { type ClaimChoice, editionKey, type FastAddPlan, type FastAddReference, fastAddHref, OTHER, UNSURE } from "@/features/collection/fast-add";
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
    { key: "packaging", label: "Packaging", value: packagingLabel(release.packagingCode, release.packaging) },
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

/** A step's heading and its choices. */
function Step({ id, number, title, children }: { id: string; number: number; title: string; children: ReactNode }) {
  return (
    <section aria-labelledby={id} className="flex flex-col gap-2">
      <h3 id={id} className="text-sm font-medium">
        <span className="text-muted-foreground">{number}. </span>
        {title}
      </h3>
      {children}
    </section>
  );
}

/** The catalog's name for an edition, or that it records none. */
function catalogEditionText(edition: { kind: string | null; name: string | null }) {
  return editionText(edition.kind || edition.name ? { kind: edition.kind, name: edition.name } : null) ?? "Edition not recorded";
}

const otherSelectClassName =
  "h-10 min-w-48 flex-1 rounded-lg border border-input bg-background px-2.5 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring dark:bg-input/30";

/** "Another …" from the full list, as a plain GET form, so it works without JavaScript. */
function OtherChoice({
  action,
  name,
  label,
  keep,
  options,
  hint,
}: {
  action: string;
  name: string;
  label: string;
  keep: Record<string, string>;
  options: { value: string; text: string }[];
  hint: string;
}) {
  const id = `other-${name}`;
  return (
    <form action={action} method="get" className="flex flex-col gap-2 rounded-lg border p-3">
      {Object.entries(keep).map(([k, v]) => (
        <input key={k} type="hidden" name={k} value={v} />
      ))}
      <label htmlFor={id} className="text-sm font-medium">
        {label}
      </label>
      <p id={`${id}-hint`} className="text-xs text-muted-foreground">
        {hint}
      </p>
      <div className="flex flex-wrap gap-2">
        <select id={id} name={name} required defaultValue="" aria-describedby={`${id}-hint`} className={otherSelectClassName}>
          <option value="" disabled>
            Choose…
          </option>
          {options.map((o) => (
            <option key={o.value} value={o.value}>
              {o.text}
            </option>
          ))}
        </select>
        <button type="submit" className={cn(chipClassName, "bg-card font-medium hover:bg-muted")}>
          Continue
        </button>
      </div>
    </form>
  );
}

type Href = Partial<{ platform: string | null; region: string | null; edition: string | null; release: string | null }>;

/**
 * The game, and adding it to a collection in four steps (M12b): platform, region,
 * edition, add. Each step offers the catalog's choices first, then another one or "Not
 * sure". When the choices name exactly one published release, `renderAdd` adds it (as
 * does the only release of a game, as before); when several match, the owner picks one
 * or adds the copy without one; when the choice isn't a published release,
 * `renderClaim` adds an unidentified copy with what they know. `renderOwnership` shows
 * what the signed-in owner already has. Those three read the session, so they're
 * rendered apart from this public view. `requestedRelease` is set when the address
 * named a release that isn't shown.
 */
export function ReleasePickerView({
  picker,
  plan,
  reference,
  renderAdd,
  renderClaim,
  renderOwnership,
  requestedRelease = false,
}: {
  picker: ReleasePicker;
  plan: FastAddPlan<PickerRelease>;
  reference: FastAddReference;
  renderAdd?: (release: PickerRelease) => ReactNode;
  renderClaim?: (claim: ClaimChoice) => ReactNode;
  renderOwnership?: ReactNode;
  requestedRelease?: boolean;
}) {
  const { game } = picker;
  const meta = [game.firstRelease ? formatCatalogDate(game.firstRelease) : null, gameKindLabel(game.kind)].filter(Boolean);
  const outcome = plan.outcome;
  // A game with a single release offers it straight away, as before.
  const only = !outcome && !plan.platform && !plan.choosingPlatform && picker.releases.length === 1 ? picker.releases[0] : null;
  const target = outcome?.kind === "release" ? outcome.release : only;

  const platform = plan.platform;
  const regionValue = plan.region === "unsure" ? UNSURE : plan.region ? plan.region.code : null;
  const editionValue = plan.edition === "unsure" ? UNSURE : plan.edition === "other" ? OTHER : plan.edition ? plan.edition.key : null;
  const href = (s: Href) => fastAddHref(game.slug, s);
  const platformName = (slug: string) => picker.platforms.find((p) => p.slug === slug)?.name ?? reference.platforms.find((p) => p.slug === slug)?.name ?? slug;
  const regionText = (code: string) => {
    const known = picker.regions.find((r) => r.code === code) ?? reference.regions.find((r) => r.code === code);
    return known ? regionLabel(known) : code;
  };

  // The catalog's releases for what's chosen so far. None for a platform or region the
  // catalog doesn't have for this game; only the matches when several match.
  const shown =
    outcome?.kind === "choose"
      ? outcome.releases
      : (platform && !platform.inCatalog) || (plan.region && plan.region !== "unsure" && !plan.region.inCatalog)
        ? []
        : picker.releases.filter((r) => !platform || r.platform.slug === platform.slug);
  const varying = new Set<string>();
  const rows = shown.map((r) => new Map(details(r).map((row) => [row.key, row.value])));
  for (const key of new Set(rows.flatMap((m) => [...m.keys()]))) {
    if (new Set(rows.map((m) => m.get(key) ?? "")).size > 1) varying.add(key);
  }

  // What's added without a release: the claim the steps chose, or, when several
  // releases match, the same choice without picking one.
  const claim: ClaimChoice | null =
    outcome?.kind === "claim"
      ? outcome.claim
      : outcome?.kind === "choose" && platform
        ? {
            platform: platform.slug,
            region: plan.region && plan.region !== "unsure" && plan.region.code !== "unknown" ? plan.region.code : null,
            edition: plan.edition && typeof plan.edition === "object" ? { kind: plan.edition.kind, name: plan.edition.name } : null,
          }
        : null;
  const claimSummary = (c: ClaimChoice) =>
    [
      platformName(c.platform),
      c.region ? regionText(c.region) : "Region not sure",
      c.edition === "other" ? null : c.edition ? catalogEditionText(c.edition) : "Edition not sure",
    ]
      .filter(Boolean)
      .join(" · ");

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

      {renderOwnership}

      <section aria-labelledby="choose-release" className="mt-6 flex flex-col gap-5">
        <h2 id="choose-release" className="text-base font-semibold">
          Add to your collection
        </h2>

        <Step id="step-platform" number={1} title="Platform">
          <Chips
            label="Platform"
            items={[
              ...picker.platforms.map((p) => ({
                key: p.slug,
                text: p.name,
                count: p.releaseCount,
                href: href({ platform: p.slug }),
                current: platform?.slug === p.slug,
              })),
              ...(platform && !platform.inCatalog
                ? [{ key: platform.slug, text: `${platformName(platform.slug)} (not in the catalog)`, href: href({ platform: platform.slug }), current: true }]
                : []),
              { key: OTHER, text: "Another platform", href: href({ platform: OTHER }), current: plan.choosingPlatform },
            ]}
          />
          {plan.choosingPlatform ? (
            <OtherChoice
              action={`/games/${game.slug}`}
              name="platform"
              label="Your platform"
              keep={{}}
              hint="The catalog doesn't list this game on it yet. You can still add your copy, as your own record, not a verified release."
              options={reference.platforms.filter((p) => !picker.platforms.some((c) => c.slug === p.slug)).map((p) => ({ value: p.slug, text: p.name }))}
            />
          ) : null}
          {platform && !platform.inCatalog ? (
            <p className="text-xs text-muted-foreground">
              The catalog doesn&apos;t list {game.title} on {platformName(platform.slug)}. Your copy is kept as your own, unverified record.
            </p>
          ) : null}
        </Step>

        {platform ? (
          <Step id="step-region" number={2} title="Region">
            <Chips
              label="Region"
              items={[
                ...(platform.inCatalog ? picker.regions : []).map((r) => ({
                  key: r.code,
                  text: regionLabel(r),
                  count: r.releaseCount,
                  href: href({ platform: platform.slug, region: r.code }),
                  current: regionValue === r.code,
                })),
                ...(plan.region && plan.region !== "unsure" && !plan.region.inCatalog
                  ? [{ key: plan.region.code, text: `${regionText(plan.region.code)} (not in the catalog)`, href: href({ platform: platform.slug, region: plan.region.code }), current: true }]
                  : []),
                { key: OTHER, text: "Another region", href: href({ platform: platform.slug, region: OTHER }), current: plan.choosingRegion },
                { key: UNSURE, text: "Not sure", href: href({ platform: platform.slug, region: UNSURE }), current: plan.region === "unsure" },
              ]}
            />
            {plan.choosingRegion ? (
              <OtherChoice
                action={`/games/${game.slug}`}
                name="region"
                label="Your region"
                keep={{ platform: platform.slug }}
                hint="The catalog has no release of this game for it yet. Your copy is kept as your own record."
                options={reference.regions.filter((r) => !(platform.inCatalog && picker.regions.some((c) => c.code === r.code))).map((r) => ({ value: r.code, text: r.label }))}
              />
            ) : null}
          </Step>
        ) : null}

        {platform && plan.region ? (
          <Step id="step-edition" number={3} title="Edition">
            <Chips
              label="Edition"
              items={[
                ...plan.editions.map((e) => ({
                  key: e.key,
                  text: catalogEditionText(e),
                  count: plan.region !== "unsure" ? e.count : undefined,
                  href: href({ platform: platform.slug, region: regionValue, edition: e.key }),
                  current: editionValue === e.key,
                })),
                {
                  key: OTHER,
                  text: plan.editions.length ? "Another edition" : "Name the edition",
                  href: href({ platform: platform.slug, region: regionValue, edition: OTHER }),
                  current: plan.edition === "other",
                },
                { key: UNSURE, text: "Not sure", href: href({ platform: platform.slug, region: regionValue, edition: UNSURE }), current: plan.edition === "unsure" },
              ]}
            />
          </Step>
        ) : null}

        {requestedRelease && !target ? (
          <p className="flex gap-2 rounded-lg border p-3 text-sm text-muted-foreground">
            <Info aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
            {picker.selection.releaseId
              ? "That release doesn't match what you chose, so it isn't added. Choose it below to add your copy as that release."
              : "That release isn't available. Choose one of the releases below."}
          </p>
        ) : null}

        {target ? (
          <section aria-labelledby="add-release" className="flex flex-col gap-3 rounded-lg border border-primary/40 bg-primary/5 p-3">
            <h3 id="add-release" className="text-sm font-medium">
              {outcome ? "Your release" : "The only release"}: {target.platform.shortName} · {regionLabel(target.region)}
              {target.edition?.name ? ` · ${target.edition.name}` : ""}
            </h3>
            {renderAdd ? renderAdd(target) : null}
            {outcome ? (
              <p className="text-sm">
                <Link href={href({})} scroll={false} className="text-primary-text underline underline-offset-4">
                  Start over
                </Link>
              </p>
            ) : null}
          </section>
        ) : null}

        {outcome?.kind === "choose" ? (
          <p className="text-sm">{outcome.releases.length} releases in the catalog match. Choose yours below, or add your copy without one.</p>
        ) : null}

        {claim ? (
          <section aria-labelledby="add-claim" className="flex flex-col gap-3 rounded-lg border border-dashed p-3">
            <h3 id="add-claim" className="text-sm font-medium">
              {outcome?.kind === "choose" ? "Not sure which one?" : `Your copy: ${claimSummary(claim)}`}
            </h3>
            <p className="text-sm text-muted-foreground">
              {outcome?.kind === "choose" ? "Add it without a release" : "This isn't a release in the catalog, so your copy is added without one"}: it&apos;s your own record, not a
              verified release, and nothing is added to the catalog. You can link it to a release later.
            </p>
            {renderClaim ? renderClaim(claim) : null}
          </section>
        ) : null}

        {!target && !outcome && !plan.choosingPlatform && picker.releases.length > 1 ? (
          <p className="text-sm text-muted-foreground">Choose the platform, region and edition you have, or pick your release below.</p>
        ) : null}

        {shown.length ? (
          <section aria-labelledby="catalog-releases" className="flex flex-col gap-2">
            <h3 id="catalog-releases" className="text-sm font-medium">
              {outcome?.kind === "choose" ? "Matching releases" : "Releases in the catalog"}
            </h3>
            <ul aria-label="Releases" className="flex flex-col gap-2">
              {shown.map((release) => (
                <li key={release.id}>
                  <ReleaseCard
                    release={release}
                    selected={outcome?.kind === "release" && target?.id === release.id}
                    varying={varying}
                    href={href({ platform: release.platform.slug, region: release.region.code, edition: editionKey(release.edition), release: release.id })}
                  />
                </li>
              ))}
            </ul>
          </section>
        ) : null}
        <p className="text-sm text-muted-foreground">
          Can&apos;t find your release?{" "}
          <Link href={`/submit?game=${game.slug}`} className="text-primary-text underline underline-offset-4">
            Submit it to the catalog
          </Link>
          . You can add your copy right away, while it&apos;s reviewed.
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
