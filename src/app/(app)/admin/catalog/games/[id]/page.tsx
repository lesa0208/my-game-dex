import { PlugZap } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { AdminFrame, AdminShell, linkClass, param } from "@/components/admin/admin-frame";
import { Facts, HistoryList, RecordSection, StatusBadge } from "@/components/admin/records";
import { EmptyState } from "@/components/shared/empty-state";
import { Button } from "@/components/ui/button";
import { requireAdminSection } from "@/features/admin/queries";
import { aliasKindLabel, formatCatalogDate, gameKindLabel, languageName } from "@/features/catalog/format";
import { formatDay } from "@/features/collection/details";
import { UUID } from "@/features/collection/uuid";
import { recordFieldLabel, recordStatusLabel, searchHref } from "@/features/records/form";
import { getGameRecord, getRecordHistory } from "@/features/records/queries";
import { requestStatusLabel } from "@/features/review/form";
import { formatWhen } from "@/features/submissions/display";

export const metadata: Metadata = {
  title: "Game record",
};

const RELATIONS: Record<string, { outgoing: string; incoming: string }> = {
  remake_of: { outgoing: "A remake of", incoming: "Remade as" },
  remaster_of: { outgoing: "A remaster of", incoming: "Remastered as" },
  contains: { outgoing: "Contains", incoming: "Included in" },
};

async function GameRecordView({ params, searchParams }: { params: PageProps<"/admin/catalog/games/[id]">["params"]; searchParams: PageProps<"/admin/catalog/games/[id]">["searchParams"] }) {
  const { id } = await params;
  const search = await searchParams;
  // Catalog editors only (D8); staff signed in without their authenticator verify first.
  const { access } = await requireAdminSection(UUID.test(id) ? `/admin/catalog/games/${id}` : "/admin/catalog/search", "editor");
  const before = param(search.before);
  const [outcome, history] = await Promise.all([getGameRecord(id), getRecordHistory("game", id, before)]);
  if (!outcome.ok) {
    if (outcome.reason === "refused") notFound();
    return (
      <AdminFrame access={access} current="catalog" title="Game record">
        <EmptyState icon={PlugZap} title="This record isn't available">
          It can&apos;t be loaded right now. Try again later.
        </EmptyState>
      </AdminFrame>
    );
  }
  const g = outcome.data;
  if (!g) notFound();
  const kind = gameKindLabel(g.kind as "game" | "compilation" | "expansion");

  return (
    <AdminFrame access={access} current="catalog" title={g.title} titleId="game-record-title">
      <article aria-labelledby="game-record-title" className="flex flex-col gap-4">
        <p className="text-sm">
          <Link href="/admin/catalog/search" className={linkClass}>
            Catalog records
          </Link>
        </p>
        <header className="flex flex-col gap-2">
          <p className="text-sm text-muted-foreground">Game record{kind ? ` · ${kind}` : ""}</p>
          <p className="flex flex-wrap items-center gap-2 text-sm">
            <StatusBadge status={g.status} />
            {g.verified_at ? `Verified ${formatDay(g.verified_at)}` : "Not verified"}
            {g.status === "published" && g.slug ? (
              <Link href={`/games/${g.slug}`} className={linkClass}>
                Public page
              </Link>
            ) : null}
          </p>
          {g.merged_into ? (
            <p className="rounded-lg border px-4 py-3 text-sm">
              Merged into{" "}
              <Link href={`/admin/catalog/games/${g.merged_into.id}`} className={linkClass}>
                {g.merged_into.title}
              </Link>{" "}
              ({recordStatusLabel(g.merged_into.status)}).
            </p>
          ) : null}
        </header>

        <RecordSection id="game-details" title="Details">
          <Facts
            label="Game details"
            rows={[
              { label: "Title", value: g.title },
              { label: "Sort title", value: g.sort_title !== g.title ? g.sort_title : null },
              { label: "Type", value: kind ?? "Game" },
              { label: "First released", value: g.first_release ? formatCatalogDate(g.first_release) : "Not recorded" },
              { label: "Summary", value: g.summary },
              { label: "Public address", value: g.slug ? `/games/${g.slug}` : null },
              { label: "Revision", value: String(g.revision) },
              { label: "Added", value: formatWhen(g.created_at) },
              { label: "Last changed", value: formatWhen(g.updated_at) },
              { label: "Id", value: <code className="text-xs break-all">{g.id}</code> },
            ]}
          />
        </RecordSection>

        <RecordSection id="game-titles" title="Other titles">
          {g.aliases.length ? (
            <ul className="flex flex-col gap-1.5 text-sm">
              {g.aliases.map((a) => (
                <li key={`${a.title}-${a.language_code}-${a.region_code}`}>
                  {a.title}{" "}
                  <span className="text-muted-foreground">
                    · {[aliasKindLabel(a.kind), a.language_code ? languageName(a.language_code) : null, a.region_code].filter(Boolean).join(" · ")}
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-muted-foreground">No other titles are recorded.</p>
          )}
        </RecordSection>

        <RecordSection id="game-platforms" title="Platforms">
          {g.platforms.length ? (
            <ul className="flex flex-col gap-1.5 text-sm">
              {g.platforms.map((p) => (
                <li key={p.slug} className="flex flex-wrap items-center gap-2">
                  {p.name} <StatusBadge status={p.status} />
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-muted-foreground">It isn&apos;t paired with a platform yet.</p>
          )}
        </RecordSection>

        <RecordSection id="game-releases" title={`Releases (${g.release_count.toLocaleString("en")})`}>
          {g.releases.length ? (
            <ul className="flex flex-col gap-2 text-sm">
              {g.releases.map((r) => {
                const region = r.region ? (r.region.code === "unknown" ? "Region unknown" : r.region.label) : null;
                return (
                  <li key={r.id} className="flex flex-col gap-0.5">
                    <Link href={`/admin/catalog/releases/${r.id}`} className={linkClass}>
                      {[r.platform?.short_name, region, r.format, r.edition_name, r.variant_name, r.product_code].filter(Boolean).join(" · ") || "Release"}
                    </Link>
                    <span className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                      <StatusBadge status={r.status} />
                      {r.verified ? "Verified" : "Not verified"}
                    </span>
                  </li>
                );
              })}
            </ul>
          ) : (
            <p className="text-sm text-muted-foreground">It has no releases.</p>
          )}
          {g.release_count > g.releases.length ? (
            <p className="mt-3 text-sm">
              <Link href={searchHref({ kind: "releases", query: g.id, platform: null, status: null })} className={linkClass}>
                All {g.release_count.toLocaleString("en")} releases
              </Link>
            </p>
          ) : null}
        </RecordSection>

        {g.relations.length ? (
          <RecordSection id="game-relations" title="Related games">
            <ul className="flex flex-col gap-1.5 text-sm">
              {g.relations.map((r) => (
                <li key={`${r.direction}-${r.relation}-${r.game.id}`}>
                  {RELATIONS[r.relation]?.[r.direction] ?? r.relation}{" "}
                  <Link href={`/admin/catalog/games/${r.game.id}`} className={linkClass}>
                    {r.game.title}
                  </Link>{" "}
                  <span className="text-muted-foreground">({recordStatusLabel(r.game.status)})</span>
                </li>
              ))}
            </ul>
          </RecordSection>
        ) : null}

        <RecordSection id="game-sources" title="Sources and locks">
          <Facts
            label="Sources and locks"
            rows={[
              {
                label: "External references",
                value: g.external_references.length ? g.external_references.map((r) => `${r.provider}: ${r.external_id}`).join(", ") : "None",
              },
              {
                label: "Locked against imports",
                value: g.field_locks.length ? g.field_locks.map((l) => `${recordFieldLabel(l.field)} (${formatDay(l.locked_at)})`).join(", ") : "Nothing",
              },
            ]}
          />
        </RecordSection>

        {g.submissions.length ? (
          <RecordSection id="game-submissions" title="Submissions">
            <ul className="flex flex-col gap-1.5 text-sm">
              {g.submissions.map((s) => (
                <li key={s.id}>
                  <Link href={`/admin/catalog/${s.id}`} className={linkClass}>
                    {s.kind === "new_game" ? "New game" : "Missing release"}, {formatDay(s.created_at)}
                  </Link>{" "}
                  <span className="text-muted-foreground">· {requestStatusLabel(s.status)}</span>
                </li>
              ))}
            </ul>
          </RecordSection>
        ) : null}

        <RecordSection id="history" title="History">
          {!history.ok || !history.data ? (
            <p className="text-sm text-muted-foreground">The history can&apos;t be loaded right now.</p>
          ) : (
            <>
              <HistoryList history={history.data} recordId={g.id} admin={access.admin} />
              {before || history.data.next_before ? (
                <nav aria-label="History pages" className="mt-4 flex flex-wrap items-center justify-between gap-2">
                  {before ? (
                    <Button asChild variant="ghost" size="lg">
                      <Link href={`/admin/catalog/games/${g.id}#history`}>Latest</Link>
                    </Button>
                  ) : (
                    <span />
                  )}
                  {history.data.next_before ? (
                    <Button asChild variant="secondary" size="lg">
                      <Link href={`/admin/catalog/games/${g.id}?before=${history.data.next_before}#history`}>Older</Link>
                    </Button>
                  ) : null}
                </nav>
              ) : null}
            </>
          )}
        </RecordSection>
      </article>
    </AdminFrame>
  );
}

export default function GameRecordPage({ params, searchParams }: PageProps<"/admin/catalog/games/[id]">) {
  return (
    <AdminShell>
      <GameRecordView params={params} searchParams={searchParams} />
    </AdminShell>
  );
}
