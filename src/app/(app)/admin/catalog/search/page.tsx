import { PlugZap, SearchX } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";

import { AdminFrame, AdminShell, linkClass } from "@/components/admin/admin-frame";
import { StatusBadge } from "@/components/admin/records";
import { EmptyState } from "@/components/shared/empty-state";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { requireAdminSection } from "@/features/admin/queries";
import { RECORD_STATUSES, SEARCH_KINDS, readSearchParams, searchHref } from "@/features/records/form";
import { searchCatalogRecords } from "@/features/records/queries";
import type { GameSummary, ReleaseSummary } from "@/features/records/queries";
import { getSubmissionOptions } from "@/features/submissions/queries";

export const metadata: Metadata = {
  title: "Catalog records",
};

const selectClass =
  "h-10 w-full rounded-lg border border-input bg-transparent px-3 text-base outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring md:text-sm dark:bg-input/30";
const rowClass =
  "flex flex-col gap-1 rounded-lg border bg-card p-3 outline-none transition-colors hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring";

function GameRow({ game }: { game: GameSummary }) {
  const line = [
    game.first_release ? game.first_release.value.slice(0, 4) : null,
    game.platforms.length ? game.platforms.join(", ") : "No platform yet",
    game.releases.total === 1 ? "1 release" : `${game.releases.total} releases`,
    game.releases.total ? `${game.releases.published} published` : null,
  ]
    .filter(Boolean)
    .join(" · ");
  return (
    <Link href={`/admin/catalog/games/${game.id}`} className={rowClass}>
      <span className="font-medium text-pretty">{game.title}</span>
      <span className="text-sm text-muted-foreground">{line}</span>
      <span className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        <StatusBadge status={game.status} />
        {game.verified ? "Verified" : "Not verified"}
        {game.merged_into_id ? " · Merged into another game" : ""}
      </span>
    </Link>
  );
}

function ReleaseRow({ release }: { release: ReleaseSummary }) {
  const region = release.region ? (release.region.code === "unknown" ? "Region unknown" : release.region.label) : null;
  const line = [release.platform?.short_name, region, release.format, release.edition_name, release.variant_name, release.product_code].filter(Boolean).join(" · ");
  return (
    <Link href={`/admin/catalog/releases/${release.id}`} className={rowClass}>
      <span className="font-medium text-pretty">{release.game?.title ?? "Release"}</span>
      {line ? <span className="text-sm text-muted-foreground">{line}</span> : null}
      <span className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        <StatusBadge status={release.status} />
        {release.verified ? "Verified" : "Not verified"}
        {release.merged_into_id ? " · Merged into another release" : ""}
      </span>
    </Link>
  );
}

async function SearchView({ searchParams }: { searchParams: PageProps<"/admin/catalog/search">["searchParams"] }) {
  const params = readSearchParams(await searchParams);
  // Catalog editors only (D8); staff signed in without their authenticator verify first,
  // then come back to this same search.
  const { access } = await requireAdminSection(searchHref(params), "editor");
  const [outcome, options] = await Promise.all([searchCatalogRecords(params), getSubmissionOptions()]);
  const first = searchHref({ ...params, cursor: null });

  return (
    <AdminFrame access={access} current="catalog" title="Catalog records">
      <p className="text-sm text-muted-foreground">
        Every game and release, published or not, merged, excluded and rejected ones included. Search by title, another title, product code, barcode or id.{" "}
        <Link href="/admin/catalog" className={linkClass}>
          Review queue
        </Link>
      </p>
      <div role="search" aria-label="Catalog records">
        <form method="get" action="/admin/catalog/search" className="grid gap-3 sm:grid-cols-2">
          <div className="flex min-w-0 flex-col gap-1.5 sm:col-span-2">
            <label htmlFor="records-q" className="text-sm font-medium">
              Search
            </label>
            <Input id="records-q" name="q" type="search" maxLength={100} defaultValue={params.query} autoComplete="off" spellCheck={false} className="h-10" />
          </div>
          <fieldset className="flex min-w-0 flex-col gap-1.5 sm:col-span-2">
            <legend className="mb-1.5 text-sm font-medium">Show</legend>
            <div className="flex flex-wrap gap-4">
              {SEARCH_KINDS.map((k) => (
                <div key={k.value} className="flex min-h-10 items-center gap-2 text-sm">
                  <input id={`records-kind-${k.value}`} type="radio" name="kind" value={k.value} defaultChecked={params.kind === k.value} className="size-4 accent-primary" />
                  <label htmlFor={`records-kind-${k.value}`}>{k.label}</label>
                </div>
              ))}
            </div>
          </fieldset>
          <div className="flex min-w-0 flex-col gap-1.5">
            <label htmlFor="records-platform" className="text-sm font-medium">
              Platform
            </label>
            <select id="records-platform" name="platform" defaultValue={params.platform ?? ""} className={selectClass}>
              <option value="">Any platform</option>
              {(options?.platforms ?? []).map((p) => (
                <option key={p.slug} value={p.slug}>
                  {p.name}
                </option>
              ))}
            </select>
          </div>
          <div className="flex min-w-0 flex-col gap-1.5">
            <label htmlFor="records-status" className="text-sm font-medium">
              Status
            </label>
            <select id="records-status" name="status" defaultValue={params.status ?? ""} className={selectClass}>
              <option value="">Any status</option>
              {RECORD_STATUSES.map((s) => (
                <option key={s.value} value={s.value}>
                  {s.label}
                </option>
              ))}
            </select>
          </div>
          <div className="flex flex-wrap gap-2 sm:col-span-2">
            <Button type="submit" variant="secondary" size="lg" className="h-10 px-4">
              Search
            </Button>
            <Button asChild variant="ghost" size="lg" className="h-10 px-4">
              <Link href="/admin/catalog/search">Clear</Link>
            </Button>
          </div>
        </form>
      </div>

      {!outcome.ok ? (
        outcome.reason === "refused" ? (
          <EmptyState icon={SearchX} title="That search didn't work">
            Check the search and filters, and try again.
          </EmptyState>
        ) : (
          <EmptyState icon={PlugZap} title="Search isn't available">
            It can&apos;t be loaded right now. Try again later.
          </EmptyState>
        )
      ) : outcome.data.status === "too_short" ? (
        <EmptyState icon={SearchX} title="Type a little more">
          A search needs at least two letters or digits.
        </EmptyState>
      ) : outcome.data.status === "unknown_platform" ? (
        <EmptyState icon={SearchX} title="No such platform">
          Choose a platform from the list.
        </EmptyState>
      ) : !outcome.data.items.length ? (
        <EmptyState icon={SearchX} title="Nothing found">
          {params.cursor ? "There are no more results." : "No record matches this search."}
        </EmptyState>
      ) : (
        <section aria-labelledby="records-results">
          <h2 id="records-results" className="sr-only">
            {params.kind === "games" ? "Games" : "Releases"}, by title
          </h2>
          <ol className="flex flex-col gap-2">
            {outcome.data.kind === "games"
              ? outcome.data.items.map((g) => (
                  <li key={g.id}>
                    <GameRow game={g} />
                  </li>
                ))
              : outcome.data.items.map((r) => (
                  <li key={r.id}>
                    <ReleaseRow release={r} />
                  </li>
                ))}
          </ol>
          {params.cursor || outcome.data.next_cursor ? (
            <nav aria-label="Pages" className="mt-4 flex flex-wrap items-center justify-between gap-2">
              {params.cursor ? (
                <Button asChild variant="ghost" size="lg">
                  <Link href={first}>First page</Link>
                </Button>
              ) : (
                <span />
              )}
              {outcome.data.next_cursor ? (
                <Button asChild variant="secondary" size="lg">
                  <Link href={searchHref({ ...params, cursor: outcome.data.next_cursor })}>Next page</Link>
                </Button>
              ) : null}
            </nav>
          ) : null}
        </section>
      )}
    </AdminFrame>
  );
}

export default function CatalogSearchPage({ searchParams }: PageProps<"/admin/catalog/search">) {
  return (
    <AdminShell>
      <SearchView searchParams={searchParams} />
    </AdminShell>
  );
}
