import { AlertTriangle, Info, PlugZap, ShieldAlert } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { AdminFrame, AdminShell, linkClass, param } from "@/components/admin/admin-frame";
import { IdentityPublication } from "@/components/admin/identity-publication";
import { PairingEvidenceList } from "@/components/admin/pairing-evidence";
import { Facts, HistoryList, RecordSection, StatusBadge } from "@/components/admin/records";
import { editable, EditNotice, ReviewPanel } from "@/components/admin/review-panel";
import { EmptyState } from "@/components/shared/empty-state";
import { Button } from "@/components/ui/button";
import { requireAdminSection } from "@/features/admin/queries";
import { aliasKindLabel, formatCatalogDate, gameKindLabel, languageName } from "@/features/catalog/format";
import { formatDay } from "@/features/collection/details";
import { UUID } from "@/features/collection/uuid";
import { wikidataConfigured, wikidataLabels } from "@/features/enrichment/wikidata";
import { recordFieldLabel, recordStatusLabel, searchHref } from "@/features/records/form";
import { publishMessage } from "@/features/publication/form";
import { getGamePairingEvidence, getGameRecord, getGameSourceFacts, getRecordHistory } from "@/features/records/queries";
import { alternativeTitles, formatLines, missingFacts, platformDates, sourceDate, sourceIds, warningsOf } from "@/features/records/source-facts";
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

/** One plain sentence for where the record stands. */
function plainStatus(status: string, verified: boolean): string {
  if (status === "published") return verified ? "Public. Checked by an editor." : "Public.";
  if (status === "under_review" || status === "unverified") return verified ? "In review: checked by an editor, not public yet." : "In review: not checked by an editor yet, and not public.";
  return `${recordStatusLabel(status)}: not public.`;
}

const WARNING_ICON = { critical: ShieldAlert, check: AlertTriangle, note: Info };
const WARNING_LABEL = { critical: "Possible error", check: "Check", note: "Note" };

/** A Wikidata id with its label when Wikidata gave one, always linked, never a guessed name. */
function WikidataItem({ id, labels }: { id: string; labels: Record<string, string> }) {
  return (
    <a href={`https://www.wikidata.org/wiki/${id}`} className={linkClass} rel="noreferrer" target="_blank">
      {labels[id] ?? id}
      {labels[id] ? <span className="text-muted-foreground"> ({id})</span> : null}
    </a>
  );
}

function ItemList({ ids, labels, none }: { ids: string[]; labels: Record<string, string>; none: string }) {
  if (!ids.length) return <span className="text-muted-foreground">{none}</span>;
  return (
    <span>
      {ids.map((id, i) => (
        <span key={id}>
          {i ? ", " : ""}
          <WikidataItem id={id} labels={labels} />
        </span>
      ))}
    </span>
  );
}

async function GameRecordView({ params, searchParams }: { params: PageProps<"/admin/catalog/games/[id]">["params"]; searchParams: PageProps<"/admin/catalog/games/[id]">["searchParams"] }) {
  const { id } = await params;
  const search = await searchParams;
  // Catalog editors only (D8); staff signed in without their authenticator verify first.
  const { access } = await requireAdminSection(UUID.test(id) ? `/admin/catalog/games/${id}` : "/admin/catalog/search", "editor");
  const before = param(search.before);
  const [outcome, history, evidence, sourceOutcome] = await Promise.all([getGameRecord(id), getRecordHistory("game", id, before), getGamePairingEvidence(id), getGameSourceFacts(id)]);
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
  const facts = sourceOutcome.ok ? sourceOutcome.data : null;
  const kind = gameKindLabel(g.kind as "game" | "compilation" | "expansion");
  const path = `/admin/catalog/games/${g.id}`;
  const platform = g.platforms[0]?.slug ?? null;
  const developers = sourceIds(facts, "developers");
  const publishers = sourceIds(facts, "publishers");
  const onPlatform = platform ? platformDates(facts, platform) : [];
  const places = [...new Set(onPlatform.flatMap((d) => d.places))];
  const labels = await wikidataLabels([...developers, ...publishers, ...places]);
  const titles = alternativeTitles(g.title, facts, g.aliases);
  const warnings = warningsOf(facts);
  const formats = platform ? formatLines(facts, platform) : [];
  const missing = missingFacts(facts, g, platform);
  const source = facts?.sources[0] ?? null;

  return (
    <AdminFrame access={access} current="catalog" title={g.title} titleId="game-record-title">
      <article aria-labelledby="game-record-title" className="flex flex-col gap-4">
        <p className="text-sm">
          <Link href="/admin/catalog/search" className={linkClass}>
            Catalog records
          </Link>
        </p>
        <EditNotice notice={param(search.notice)} />
        <header className="flex flex-col gap-2">
          <p className="text-sm text-muted-foreground">
            {[kind ?? "Game", g.platforms.map((p) => p.name).join(", ") || "No platform yet", g.first_release ? formatCatalogDate(g.first_release) : null].filter(Boolean).join(" · ")}
          </p>
          <p className="flex flex-wrap items-center gap-2 text-sm">
            <StatusBadge status={g.status} />
            {plainStatus(g.status, Boolean(g.verified_at))}
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

        {warnings.length ? (
          <RecordSection id="game-warnings" title={`Warnings (${warnings.length})`}>
            <ul className="flex flex-col gap-2 text-sm">
              {warnings.map((w) => {
                const Icon = WARNING_ICON[w.level];
                return (
                  <li key={w.text} className="flex gap-2">
                    <Icon aria-hidden="true" className={w.level === "critical" ? "mt-0.5 size-4 shrink-0 text-destructive" : "mt-0.5 size-4 shrink-0 text-muted-foreground"} />
                    <span>
                      <span className="font-medium">{WARNING_LABEL[w.level]}: </span>
                      {w.text}
                    </span>
                  </li>
                );
              })}
            </ul>
          </RecordSection>
        ) : null}

        <RecordSection id="game-essentials" title="The game">
          <Facts
            label="The game"
            rows={[
              { label: "Title", value: g.title },
              { label: "Platform", value: g.platforms.length ? g.platforms.map((p) => p.name).join(", ") : "None yet" },
              {
                label: "Released",
                value: onPlatform.length ? (
                  <ul className="flex flex-col gap-0.5">
                    {onPlatform.map((d) => (
                      <li key={`${d.value}-${d.places.join()}`}>
                        {sourceDate(d.value, d.precision)}
                        {d.places.length ? (
                          <span className="text-muted-foreground">
                            {" "}
                            · <ItemList ids={d.places} labels={labels} none="" />
                          </span>
                        ) : null}
                      </li>
                    ))}
                  </ul>
                ) : g.first_release ? (
                  `${formatCatalogDate(g.first_release)} (first release, any platform)`
                ) : (
                  "Not known"
                ),
              },
              { label: "Developer", value: <ItemList ids={developers} labels={labels} none="Not known" /> },
              { label: "Publisher", value: <ItemList ids={publishers} labels={labels} none="Not known" /> },
              {
                label: "Other titles",
                value:
                  titles.latin.length || titles.japanese.length ? (
                    <span>{[...titles.latin, ...titles.japanese].join(" · ")}</span>
                  ) : (
                    <span className="text-muted-foreground">None known</span>
                  ),
              },
              {
                label: "Formats the source names",
                value: formats.length ? (
                  <span>
                    {formats.map((f) => `${f.label}${f.physical === false ? " (digital)" : ""}${f.otherPlatform ? " (another platform)" : ""}`).join(", ")}
                    <span className="block text-xs text-muted-foreground">A source&apos;s claim, not evidence of a physical release.</span>
                  </span>
                ) : (
                  <span className="text-muted-foreground">None named</span>
                ),
              },
              { label: "Physical releases", value: g.release_count ? `${g.release_count.toLocaleString("en")} recorded` : <span className="text-muted-foreground">None recorded yet</span> },
            ]}
          />
          {missing.length ? (
            <p className="mt-3 text-sm">
              <span className="font-medium">Still unknown: </span>
              {missing.join(", ")}.
            </p>
          ) : null}
          {source && !wikidataConfigured() && (developers.length || publishers.length || places.length) ? (
            <p className="mt-2 text-xs text-muted-foreground">Names from Wikidata appear once the operator sets the Wikidata contact; until then each is shown by its Wikidata id.</p>
          ) : null}
        </RecordSection>

        <RecordSection id="game-source" title="Source">
          {source ? (
            <div className="flex flex-col gap-2 text-sm">
              <p>
                From{" "}
                <a href={`https://www.wikidata.org/wiki/${source.external_id}`} className={linkClass} rel="noreferrer" target="_blank">
                  {source.provider_name ?? source.provider} {source.external_id}
                </a>
                {source.imported_at ? `, imported ${formatDay(source.imported_at)}` : ""}
                {source.source_fetched_at ? ` (data as of ${formatDay(source.source_fetched_at)})` : ""}.
              </p>
              <p className="text-muted-foreground">
                {source.provider === "wikidata"
                  ? "Wikidata structured data, CC0 1.0: free to reuse, no attribution required. Images, descriptions and other providers' data aren't included."
                  : "Licence as recorded for this provider."}{" "}
                What a source says is a claim for an editor to check, not a verified fact.
              </p>
            </div>
          ) : sourceOutcome.ok ? (
            <p className="text-sm text-muted-foreground">
              {g.external_references.length ? `Linked to ${g.external_references.map((r) => `${r.provider} ${r.external_id}`).join(", ")}, with no imported source record.` : "Added by hand: no imported source."}
            </p>
          ) : (
            <p className="text-sm text-muted-foreground">The source can&apos;t be loaded right now.</p>
          )}
        </RecordSection>

        <RecordSection id="game-platforms" title="Physical evidence">
          {evidence.ok && evidence.data ? (
            <PairingEvidenceList pairings={evidence.data.pairings} gameRevision={evidence.data.game.revision} />
          ) : g.platforms.length ? (
            // The evidence read failed: the platforms the record itself lists, and no claim either way.
            <div className="flex flex-col gap-3">
              <p className="text-sm text-muted-foreground">The physical evidence can&apos;t be loaded right now.</p>
              <ul className="flex flex-col gap-1.5 text-sm">
                {g.platforms.map((p) => (
                  <li key={p.slug} className="flex flex-wrap items-center gap-2">
                    {p.name} <StatusBadge status={p.status} />
                  </li>
                ))}
              </ul>
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">It isn&apos;t paired with a platform yet.</p>
          )}
        </RecordSection>

        <RecordSection id="game-releases" title={`Physical releases (${g.release_count.toLocaleString("en")})`}>
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
            <p className="text-sm text-muted-foreground">No physical release is recorded yet. One is added with its evidence: product code, region and packaging.</p>
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

        {/* M15 catalog UX: every decision lives here, below the facts it rests on. The database decides; nothing here is automatic. */}
        <section id="review-actions" aria-labelledby="review-actions-title" className="flex flex-col gap-3 rounded-lg border border-dashed p-4">
          <div>
            <h2 id="review-actions-title" className="text-sm font-semibold">
              Review actions
            </h2>
            <p className="text-sm text-muted-foreground">Changes and decisions. Each one is recorded with your name; reading this page changes nothing.</p>
          </div>
          {editable(g.status) ? (
            <p className="flex flex-wrap gap-x-4 gap-y-3 text-sm">
              <Link href={`${path}/edit`} className={linkClass}>
                Edit the game
              </Link>
              <Link href={`/admin/catalog/releases/new?game=${g.id}`} className={linkClass}>
                Add a physical release
              </Link>
            </p>
          ) : null}
          <ReviewPanel
            entity="game"
            id={g.id}
            status={g.status}
            revision={g.revision}
            verified={Boolean(g.verified_at)}
            review={g.review}
            submissions={g.submissions}
            recentMfa={access.recentMfa}
            admin={access.admin}
            path={path}
          />
          {evidence.ok && evidence.data && evidence.data.pairings.length ? (
            <IdentityPublication evidence={evidence.data} recentMfa={access.recentMfa} path={path} error={publishMessage(param(search.error))} />
          ) : null}
        </section>

        <details id="advanced" className="group rounded-lg border bg-card p-4">
          <summary className="cursor-pointer text-sm font-semibold outline-none focus-visible:ring-3 focus-visible:ring-ring">Advanced details</summary>
          <div className="mt-3 flex flex-col gap-4">
            <Facts
              label="Record details"
              rows={[
                { label: "Type", value: kind ?? "Game" },
                { label: "Sort title", value: g.sort_title !== g.title ? g.sort_title : null },
                { label: "Summary", value: g.summary },
                { label: "Public address", value: g.slug ? `/games/${g.slug}` : null },
                { label: "Verified", value: g.verified_at ? formatDay(g.verified_at) : "No" },
                { label: "Revision", value: String(g.revision) },
                { label: "Added", value: formatWhen(g.created_at) },
                { label: "Last changed", value: formatWhen(g.updated_at) },
                { label: "Id", value: <code className="text-xs break-all">{g.id}</code> },
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
            {g.aliases.length ? (
              <div>
                <h3 className="mb-1 text-sm font-medium">Titles recorded on the game</h3>
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
              </div>
            ) : null}
            {facts?.sources.map((s) => (
              <Facts
                key={`${s.provider}-${s.external_id}`}
                label={`Source record ${s.external_id}`}
                rows={[
                  { label: "Source record", value: `${s.provider_name ?? s.provider} ${s.external_id}${s.source.revision ? `, revision ${s.source.revision}` : ""}` },
                  { label: "Import file", value: s.source_name },
                  { label: "File SHA-256", value: s.source_sha256 ? <code className="text-xs break-all">{s.source_sha256}</code> : null },
                  { label: "Licence terms SHA-256", value: s.terms_sha256 ? <code className="text-xs break-all">{s.terms_sha256}</code> : null },
                  { label: "IGDB ids", value: s.source.external_ids?.igdb?.join(", ") || null },
                  { label: "MobyGames ids", value: s.source.external_ids?.mobygames?.join(", ") || null },
                  { label: "Platforms Wikidata lists", value: s.source.platforms?.length ? String(s.source.platforms.length) : null },
                  { label: "Import flags", value: s.flags.length ? s.flags.join(", ") : "None" },
                ]}
              />
            ))}
            <div id="history">
              <h3 className="mb-2 text-sm font-medium">History</h3>
              {!history.ok || !history.data ? (
                <p className="text-sm text-muted-foreground">The history can&apos;t be loaded right now.</p>
              ) : (
                <>
                  <HistoryList history={history.data} recordId={g.id} admin={access.admin} />
                  {before || history.data.next_before ? (
                    <nav aria-label="History pages" className="mt-4 flex flex-wrap items-center justify-between gap-2">
                      {before ? (
                        <Button asChild variant="ghost" size="control">
                          <Link href={`/admin/catalog/games/${g.id}#history`}>Latest</Link>
                        </Button>
                      ) : (
                        <span />
                      )}
                      {history.data.next_before ? (
                        <Button asChild variant="secondary" size="control">
                          <Link href={`/admin/catalog/games/${g.id}?before=${history.data.next_before}#history`}>Older</Link>
                        </Button>
                      ) : null}
                    </nav>
                  ) : null}
                </>
              )}
            </div>
          </div>
        </details>
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
