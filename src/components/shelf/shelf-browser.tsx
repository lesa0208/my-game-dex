"use client";

import { ArrowDownUp, LayoutGrid, List, Search, SearchX, SlidersHorizontal, Star, X } from "lucide-react";
import Link from "next/link";
import { useId, useMemo, useState } from "react";

import { Button } from "@/components/ui/button";
import {
  activeFilterCount,
  browseShelf,
  COMPLETENESS,
  completenessLabel,
  conditionLabel,
  DEFAULT_FILTERS,
  type MediaKind,
  REGIONS,
  type ShelfFilters,
  type ShelfGame,
  type ShelfSort,
  SORTS,
} from "@/features/shelf/browse";
import { cn } from "@/lib/utils";

import { GameMedia } from "./game-media";
import { ShelfBoard, ShelfFillers, ShelfLight } from "./shelf-parts";

type View = "shelf" | "list";

const SHELF_COLUMNS = { base: 3, sm: 4, md: 5, lg: 6, xl: 8 } as const;

const dateFormat = new Intl.DateTimeFormat("en", { year: "numeric", month: "short", day: "numeric", timeZone: "UTC" });

function formatDate(iso: string) {
  return dateFormat.format(new Date(`${iso}T00:00:00Z`));
}

const control =
  "h-10 rounded-lg border border-input bg-input/30 px-3 text-sm outline-none transition-colors hover:bg-input/50 focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50";

export function ShelfBrowser({
  systemSlug,
  systemLabel,
  media,
  games,
}: {
  systemSlug: string;
  systemLabel: string;
  media: MediaKind;
  games: readonly ShelfGame[];
}) {
  const [view, setView] = useState<View>("shelf");
  const [sort, setSort] = useState<ShelfSort>("title");
  const [filters, setFilters] = useState<ShelfFilters>(DEFAULT_FILTERS);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const ids = useId();

  const shown = useMemo(() => browseShelf(games, sort, filters), [games, sort, filters]);
  const active = activeFilterCount(filters);
  const update = (patch: Partial<ShelfFilters>) => setFilters((current) => ({ ...current, ...patch }));
  const gameHref = (game: ShelfGame) => `/collection/systems/${systemSlug}/${game.slug}`;

  return (
    <section aria-labelledby={`${ids}-heading`}>
      <h2 id={`${ids}-heading`} className="sr-only">
        Games on the {systemLabel} shelf
      </h2>

      {/* Toolbar: search, sort, filters, and the view toggle. */}
      <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
        <div className="flex flex-wrap items-center gap-2">
          <label className="relative min-w-0 flex-1 basis-56 sm:flex-none">
            <span className="sr-only">Search this shelf</span>
            <Search aria-hidden="true" className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
            <input
              type="search"
              value={filters.query}
              onChange={(event) => update({ query: event.target.value })}
              placeholder="Search this shelf…"
              className={cn(control, "w-full pl-9 sm:w-60")}
            />
          </label>
          <label className="relative">
            <span className="sr-only">Sort</span>
            <ArrowDownUp aria-hidden="true" className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
            <select value={sort} onChange={(event) => setSort(event.target.value as ShelfSort)} className={cn(control, "select-chevron appearance-none pr-9 pl-9")}>
              {SORTS.map((option) => (
                <option key={option.value} value={option.value}>
                  Sort: {option.label}
                </option>
              ))}
            </select>
          </label>
          <Button
            type="button"
            variant="outline"
            size="control"
            aria-expanded={filtersOpen}
            aria-controls={`${ids}-filters`}
            onClick={() => setFiltersOpen((open) => !open)}
          >
            <SlidersHorizontal aria-hidden="true" />
            Filters
            {active > 0 ? <span className="ml-0.5 rounded-full bg-primary-solid px-1.5 text-xs leading-5 text-primary-solid-foreground tabular-nums">{active}</span> : null}
          </Button>
        </div>

        <div className="flex items-center justify-between gap-3 lg:justify-end">
          <p role="status" className="text-sm text-muted-foreground tabular-nums">
            {shown.length === games.length ? `${games.length} games` : `Showing ${shown.length} of ${games.length} games`}
          </p>
          <div role="group" aria-label="View" className="flex rounded-lg border border-input bg-input/20 p-1">
            {(
              [
                { value: "shelf", label: "Shelf", icon: LayoutGrid },
                { value: "list", label: "List", icon: List },
              ] as const
            ).map(({ value, label, icon: Icon }) => (
              <button
                key={value}
                type="button"
                aria-pressed={view === value}
                onClick={() => setView(value)}
                className={cn(
                  "flex h-8 items-center gap-1.5 rounded-md px-3 text-sm font-medium transition-colors outline-none focus-visible:ring-3 focus-visible:ring-ring",
                  view === value ? "bg-primary-solid text-primary-solid-foreground shadow-[0_0_16px_-4px_rgb(139_92_246/0.8)]" : "text-muted-foreground hover:text-foreground",
                )}
              >
                <Icon aria-hidden="true" className="size-4" />
                {label}
              </button>
            ))}
          </div>
        </div>
      </div>

      {filtersOpen ? (
        <div id={`${ids}-filters`} className="mt-3 flex flex-wrap items-end gap-x-6 gap-y-4 rounded-xl border bg-card/60 p-4">
          <fieldset>
            <legend className="mb-1.5 text-xs font-medium text-muted-foreground">Completeness</legend>
            <div className="flex flex-wrap gap-1.5">
              {[{ value: "all" as const, short: "All" }, ...COMPLETENESS].map((option) => (
                <label
                  key={option.value}
                  className="cursor-pointer rounded-lg border border-input px-3 py-1.5 text-sm transition-colors has-checked:border-primary has-checked:bg-primary/15 has-checked:text-foreground has-focus-visible:ring-3 has-focus-visible:ring-ring hover:bg-input/40"
                >
                  <input
                    type="radio"
                    name={`${ids}-completeness`}
                    value={option.value}
                    checked={filters.completeness === option.value}
                    onChange={() => update({ completeness: option.value })}
                    className="sr-only"
                  />
                  {option.short}
                </label>
              ))}
            </div>
          </fieldset>
          <label className="flex flex-col gap-1.5">
            <span className="text-xs font-medium text-muted-foreground">Region</span>
            <select
              value={filters.region}
              onChange={(event) => update({ region: event.target.value as ShelfFilters["region"] })}
              className={cn(control, "select-chevron appearance-none pr-9")}
            >
              <option value="all">All regions</option>
              {REGIONS.map((region) => (
                <option key={region} value={region}>
                  {region}
                </option>
              ))}
            </select>
          </label>
          <label className="flex h-10 cursor-pointer items-center gap-2 text-sm">
            <input type="checkbox" checked={filters.favoritesOnly} onChange={(event) => update({ favoritesOnly: event.target.checked })} className="size-4 accent-primary" />
            Favorites only
          </label>
          {active > 0 ? (
            <Button type="button" variant="ghost" size="control" onClick={() => setFilters(DEFAULT_FILTERS)}>
              <X aria-hidden="true" />
              Clear filters
            </Button>
          ) : null}
        </div>
      ) : null}

      <div className="mt-5">
        {shown.length === 0 ? (
          <div className="flex flex-col items-center rounded-xl border border-dashed px-6 py-14 text-center">
            <span className="flex size-12 items-center justify-center rounded-lg bg-secondary">
              <SearchX aria-hidden="true" className="size-6 text-muted-foreground" />
            </span>
            <h3 className="mt-4 font-medium">No games match</h3>
            <p className="mt-1.5 max-w-sm text-sm text-muted-foreground">Nothing on this shelf matches your search and filters.</p>
            <Button type="button" variant="secondary" size="lg" className="mt-5" onClick={() => setFilters(DEFAULT_FILTERS)}>
              Clear search and filters
            </Button>
          </div>
        ) : view === "shelf" ? (
          <ShelfView games={shown} media={media} systemLabel={systemLabel} gameHref={gameHref} />
        ) : (
          <ListView games={shown} media={media} systemLabel={systemLabel} gameHref={gameHref} />
        )}
      </div>
    </section>
  );
}

type ViewProps = { games: readonly ShelfGame[]; media: MediaKind; systemLabel: string; gameHref: (game: ShelfGame) => string };

function ShelfView({ games, media, systemLabel, gameHref }: ViewProps) {
  return (
    <div className="wood-frame rounded-xl p-1.5 shadow-[0_24px_60px_-20px_rgb(0_0_0/0.8)] sm:p-2.5">
      <ul className="shelf-wall grid grid-cols-3 overflow-hidden rounded-lg shadow-[inset_0_10px_24px_rgb(0_0_0/0.65)] sm:grid-cols-4 md:grid-cols-5 lg:grid-cols-6 xl:grid-cols-8">
        {games.map((game) => (
          <li key={game.slug} className="relative flex flex-col">
            <ShelfLight />
            <Link
              href={gameHref(game)}
              className="group relative mx-1 mt-5 mb-1 flex flex-1 flex-col items-center justify-end rounded-lg px-1 pt-2 pb-1 outline-none focus-visible:ring-2 focus-visible:ring-ring sm:mx-1.5 sm:px-1.5"
            >
              <span className="relative w-full transition-transform duration-300 group-hover:-translate-y-1 group-focus-visible:-translate-y-1 motion-reduce:transition-none motion-reduce:group-hover:translate-y-0">
                <GameMedia
                  kind={media}
                  region={game.region}
                  slug={game.slug}
                  title={game.title}
                  systemLabel={systemLabel}
                  sizes="(min-width: 1280px) 130px, (min-width: 768px) 16vw, 31vw"
                  framed
                  interactive
                />
              </span>
              <span className="mt-2.5 line-clamp-2 min-h-[2lh] w-full text-center text-[0.72rem] leading-snug font-medium text-balance text-stone-200 transition-colors group-hover:text-white sm:text-xs">
                {game.favorite ? (
                  <Star aria-hidden="true" className="mr-1 inline size-3 -translate-y-px fill-amber-300 text-amber-300" />
                ) : null}
                {game.title}
                {game.favorite ? <span className="sr-only"> (favorite)</span> : null}
              </span>
            </Link>
            <ShelfBoard />
          </li>
        ))}
        <ShelfFillers count={games.length} columns={SHELF_COLUMNS} />
      </ul>
    </div>
  );
}

function ListView({ games, media, systemLabel, gameHref }: ViewProps) {
  return (
    <ul className="divide-y overflow-hidden rounded-xl border bg-card/60">
      {games.map((game) => (
        <li key={game.slug} className="group relative flex items-center gap-3 px-3 py-2.5 transition-colors hover:bg-white/[0.03] sm:gap-4 sm:px-4">
          <div className="w-12 shrink-0 sm:w-14">
            <GameMedia kind={media} region={game.region} slug={game.slug} title={game.title} systemLabel={systemLabel} sizes="56px" />
          </div>
          <div className="min-w-0 flex-1">
            <Link
              href={gameHref(game)}
              className="font-medium outline-none after:absolute after:inset-0 hover:text-primary-text focus-visible:after:rounded-lg focus-visible:after:ring-3 focus-visible:after:ring-ring focus-visible:after:ring-inset"
            >
              {game.title}
            </Link>
            {game.favorite ? (
              <Star aria-label="Favorite" className="ml-1.5 inline size-3.5 -translate-y-px fill-amber-300 text-amber-300" />
            ) : null}
            <p className="mt-0.5 truncate text-xs text-muted-foreground">
              {game.year} · {game.publisher} · {game.genre}
            </p>
          </div>
          <dl className="hidden shrink-0 grid-cols-4 gap-6 text-sm md:grid">
            {[
              ["Region", game.region],
              ["Completeness", completenessLabel(game.completeness, true)],
              ["Condition", conditionLabel(game.condition)],
              ["Acquired", formatDate(game.acquired)],
            ].map(([label, value]) => (
              <div key={label} className="w-24">
                <dt className="text-xs text-muted-foreground">{label}</dt>
                <dd className="truncate">{value}</dd>
              </div>
            ))}
          </dl>
          <p className="shrink-0 rounded-md border px-2 py-0.5 text-xs text-muted-foreground md:hidden">
            {completenessLabel(game.completeness, true)} · {game.region}
          </p>
        </li>
      ))}
    </ul>
  );
}
