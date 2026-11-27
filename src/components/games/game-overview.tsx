import { ArrowUpRight, BookOpen, ChevronDown } from "lucide-react";
import type { ReactNode } from "react";

import { ConsoleArt } from "@/components/shelf/console-art";
import { aliasKindLabel, formatCatalogDate, gameKindLabel, languageName, regionLabel, releaseCountLabel } from "@/features/catalog/format";
import type { ProviderMetadata } from "@/features/catalog/provider-metadata";
import type { ReleasePicker } from "@/features/catalog/types";
import { consoleFor, type gameOverview } from "@/features/shelf/copies";
import { cn } from "@/lib/utils";

type Overview = ReturnType<typeof gameOverview>;
type Row = { label: string; value: ReactNode };

// Game Details 2.0, Phase 2: Overview, the game's information in one place, now that the page has
// no sidebar. The full description; the game's platforms in the catalog, each with its verified
// releases; then the details, side by side and never mixed: what the My Game Dex catalog records,
// and what IGDB says about the game. IGDB's facts are game-level: they verify no physical release.
// Only what is recorded is shown; an empty field is left out, never filled in.

/**
 * A list kept short: up to three names inline; beyond that the first two and a native disclosure
 * ("Show all 4"), keyboard- and screen-reader-operable, working without JavaScript.
 */
function ListValue({ items, noun }: { items: string[]; noun: string }) {
  if (items.length <= 3) return <>{items.join(", ")}</>;
  return (
    <div className="[&:has(details[open])>p]:hidden">
      <p>{items.slice(0, 2).join(", ")}</p>
      <details className="group">
        <summary className="mt-0.5 inline-flex min-h-6 cursor-pointer list-none items-center gap-1 rounded text-[13px] font-medium text-primary-text outline-none hover:underline focus-visible:ring-3 focus-visible:ring-ring [&::-webkit-details-marker]:hidden">
          <span className="group-open:hidden">
            Show all {items.length}
            <span className="sr-only"> {noun}</span>
          </span>
          <span className="hidden group-open:inline">
            Show fewer<span className="sr-only"> {noun}</span>
          </span>
          <ChevronDown aria-hidden="true" className="size-3.5 transition-transform group-open:rotate-180 motion-reduce:transition-none" />
        </summary>
        <ul className="flex flex-col gap-0.5 group-open:mb-1">
          {items.map((item) => (
            <li key={item}>{item}</li>
          ))}
        </ul>
      </details>
    </div>
  );
}

/** One source's details: a heading naming the source, its rows, and its note. */
function SourcePanel({ id, title, marker, rows, empty, footer, data }: { id: string; title: string; marker: ReactNode; rows: Row[]; empty: string; footer?: ReactNode; data: Record<string, string> }) {
  return (
    <section aria-labelledby={id} className="flex min-w-0 flex-col rounded-2xl border border-white/[0.08] bg-[#141319] p-4 sm:p-5" {...data}>
      <h3 id={id} className="flex items-center gap-2 text-sm font-semibold text-white">
        {marker}
        {title}
      </h3>
      {rows.length ? (
        <dl className="mt-2 divide-y divide-white/[0.06]">
          {rows.map((row) => (
            <div key={row.label} className="grid grid-cols-[6.75rem_minmax(0,1fr)] gap-x-3 py-2.5 text-sm sm:grid-cols-[8.5rem_minmax(0,1fr)] sm:gap-x-4">
              <dt className="text-muted-foreground">{row.label}</dt>
              <dd className="min-w-0 text-pretty text-white">{row.value}</dd>
            </div>
          ))}
        </dl>
      ) : (
        <p className="mt-2 text-sm text-muted-foreground">{empty}</p>
      )}
      {footer ? <div className="mt-auto pt-3">{footer}</div> : null}
    </section>
  );
}

function plural(count: number, one: string, many: string) {
  return count === 1 ? one : many;
}

export function OverviewTab({ game, overview, summary, provider = null }: { game: ReleasePicker["game"]; overview: Overview; summary: string | null; provider?: ProviderMetadata | null }) {
  const verifiedOn = (slug: string) => overview.groups.find((g) => g.platform.slug === slug)?.releases.length ?? 0;
  const anyVerified = overview.platforms.some((p) => verifiedOn(p.slug) > 0);
  const fromIgdb = !summary && provider?.summary ? provider.summary : null;
  const aliases = game.aliases.map((alias) => ({
    key: `${alias.title}-${alias.languageCode}-${alias.regionCode}`,
    text: (
      <>
        {alias.title}
        <span className="text-muted-foreground">
          {" "}
          · {aliasKindLabel(alias.kind)}
          {alias.languageCode ? `, ${languageName(alias.languageCode)}` : ""}
        </span>
      </>
    ),
  }));

  const catalogRows: Row[] = [
    game.firstRelease ? { label: "First released", value: formatCatalogDate(game.firstRelease) } : null,
    game.kind !== "game" ? { label: "Type", value: gameKindLabel(game.kind) ?? game.kind } : null,
    overview.regions.length ? { label: plural(overview.regions.length, "Region", "Regions"), value: overview.regions.map((r) => regionLabel(r)).join(", ") } : null,
    aliases.length
      ? {
          label: "Other titles",
          // Three shown; the rest a disclosure away (Super Mario World has ten).
          value: (
            <>
              <ul aria-label="Other titles" className="flex flex-col gap-0.5">
                {aliases.slice(0, aliases.length > 4 ? 3 : 4).map((a) => (
                  <li key={a.key}>{a.text}</li>
                ))}
              </ul>
              {aliases.length > 4 ? (
                <details className="group">
                  <summary className="mt-0.5 inline-flex min-h-6 cursor-pointer list-none items-center gap-1 rounded text-[13px] font-medium text-primary-text outline-none hover:underline focus-visible:ring-3 focus-visible:ring-ring [&::-webkit-details-marker]:hidden">
                    <span className="group-open:hidden">Show {aliases.length - 3} more</span>
                    <span className="hidden group-open:inline">Show fewer</span>
                    <span className="sr-only"> other titles</span>
                    <ChevronDown aria-hidden="true" className="size-3.5 transition-transform group-open:rotate-180 motion-reduce:transition-none" />
                  </summary>
                  <ul aria-label="More other titles" className="flex flex-col gap-0.5">
                    {aliases.slice(3).map((a) => (
                      <li key={a.key}>{a.text}</li>
                    ))}
                  </ul>
                </details>
              ) : null}
            </>
          ),
        }
      : null,
  ].filter((row) => row !== null);

  // IGDB's own first-release date only where it differs from the catalog's: the catalog's is said
  // above, once; a different date is IGDB's and shown as such.
  const igdbDate = provider?.firstReleaseDate && !(game.firstRelease && provider.firstReleaseDate.startsWith(game.firstRelease.value)) ? provider.firstReleaseDate : null;
  const igdbRows: Row[] = provider
    ? [
        provider.developers.length ? { label: plural(provider.developers.length, "Developer", "Developers"), value: <ListValue items={provider.developers} noun="developers" /> } : null,
        provider.publishers.length ? { label: plural(provider.publishers.length, "Publisher", "Publishers"), value: <ListValue items={provider.publishers} noun="publishers" /> } : null,
        provider.genres.length ? { label: plural(provider.genres.length, "Genre", "Genres"), value: <ListValue items={provider.genres} noun="genres" /> } : null,
        provider.themes.length ? { label: plural(provider.themes.length, "Theme", "Themes"), value: <ListValue items={provider.themes} noun="themes" /> } : null,
        provider.platforms.length ? { label: "Platforms listed", value: <ListValue items={provider.platforms} noun="platforms" /> } : null,
        igdbDate ? { label: "First release", value: formatCatalogDate({ value: igdbDate, precision: "day" }) } : null,
      ].filter((row) => row !== null)
    : [];

  return (
    <div className="flex flex-col gap-8 lg:gap-10">
      <div className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_minmax(0,20rem)] lg:gap-12 xl:grid-cols-[minmax(0,1fr)_minmax(0,23rem)]">
        <section aria-labelledby="about-game" data-summary={summary ? "yes" : fromIgdb ? "igdb" : "none"}>
          <h2 id="about-game" className="text-xl font-semibold text-white">
            About the Game
          </h2>
          {summary ? (
            <p className="mt-3 max-w-[68ch] text-[15px] leading-relaxed text-pretty text-foreground/90">{summary}</p>
          ) : fromIgdb ? (
            <>
              <p className="mt-3 max-w-[68ch] text-[15px] leading-relaxed text-pretty whitespace-pre-line text-foreground/90">{fromIgdb}</p>
              <p className="mt-2 text-xs text-muted-foreground">
                Description from{" "}
                <a href={provider?.url ?? "https://www.igdb.com"} className="underline underline-offset-2 hover:text-foreground" rel="noopener noreferrer" target="_blank">
                  IGDB.com
                </a>
                .
              </p>
            </>
          ) : (
            <p className="mt-2 flex items-center gap-2 text-sm text-muted-foreground">
              <BookOpen aria-hidden="true" className="size-4 shrink-0" />
              No description yet.
            </p>
          )}
        </section>

        {/* The game's systems in the catalog: the switcher's short names, here in full, each with
            what the catalog has verified on it. */}
        <section aria-labelledby="game-platforms" className="lg:border-l lg:border-white/[0.08] lg:pl-8" data-game-platforms="">
          <h2 id="game-platforms" className="text-base font-semibold text-white">
            {plural(overview.platforms.length, "Platform", "Platforms")}
          </h2>
          {overview.platforms.length ? (
            <ul className="mt-3 flex flex-col gap-3">
              {overview.platforms.map((p) => {
                const kind = consoleFor(p.slug);
                const verified = verifiedOn(p.slug);
                return (
                  <li key={p.slug} className="flex items-center gap-3">
                    {kind ? <ConsoleArt kind={kind} sizes="48px" className="h-7 w-10 shrink-0" /> : <span aria-hidden="true" className="w-10 shrink-0" />}
                    <span className="min-w-0 leading-tight">
                      <span className="block text-sm text-pretty text-white">{p.name}</span>
                      {anyVerified ? <span className="block text-xs text-muted-foreground">{verified ? releaseCountLabel(verified) : "No verified release yet"}</span> : null}
                    </span>
                  </li>
                );
              })}
            </ul>
          ) : (
            <p className="mt-2 text-sm text-muted-foreground">Not recorded</p>
          )}
          {/* None verified on any of them: said once, not under every platform. */}
          {overview.platforms.length && !anyVerified ? (
            <p className="mt-3 text-xs text-muted-foreground" data-platforms-unverified="">
              No physical release verified on {overview.platforms.length === 1 ? "this platform" : "these platforms"} yet.
            </p>
          ) : null}
          <a href="#releases" className="mt-3 inline-flex text-sm font-medium text-primary-text underline-offset-4 hover:underline">
            See physical releases
          </a>
        </section>
      </div>

      <section aria-labelledby="game-information">
        <h2 id="game-information" className="text-xl font-semibold text-white">
          Game Information
        </h2>
        <div className={cn("mt-3 grid items-start gap-4", provider ? "xl:grid-cols-2" : "max-w-3xl")}>
          <SourcePanel
            id="catalog-facts"
            title="My Game Dex catalog"
            marker={<span aria-hidden="true" className="size-1.5 rounded-full bg-[rgb(242_185_122)]" />}
            rows={catalogRows}
            empty="No further catalog details recorded."
            data={{ "data-catalog-facts": game.slug }}
          />
          {provider ? (
            <SourcePanel
              id="igdb-facts"
              title="From IGDB"
              marker={<span aria-hidden="true" className="size-1.5 rounded-full bg-primary-text" />}
              rows={igdbRows}
              empty="No further details recorded."
              data={{ "data-provider-facts": provider.provider }}
              footer={
                <div className="flex flex-col gap-1.5 border-t border-white/[0.06] pt-3 text-xs text-muted-foreground">
                  <p>About the game as a whole: these details don&apos;t verify any physical release, region or edition.</p>
                  <p data-igdb-credit="">
                    Game data from{" "}
                    <a href={provider.url ?? "https://www.igdb.com"} className="inline-flex items-center gap-0.5 font-medium text-primary-text underline-offset-2 hover:underline" rel="noopener noreferrer" target="_blank">
                      IGDB.com
                      <ArrowUpRight aria-hidden="true" className="size-3" />
                      <span className="sr-only"> (opens in a new tab)</span>
                    </a>
                  </p>
                </div>
              }
            />
          ) : null}
        </div>
      </section>
    </div>
  );
}
