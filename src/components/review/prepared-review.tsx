import Link from "next/link";
import type { ReactNode } from "react";

import { Button } from "@/components/ui/button";
import { publicationGaps, storedSummary, suggestedShell, type StoredEnrichment } from "@/features/enrichment/match";
import { flagText, sourceDate } from "@/features/records/source-facts";
import { lookUpSubmissionAgain } from "@/features/review/actions";
import { catalogStatusLabel } from "@/features/review/form";
import type { ReviewRelease } from "@/features/review/queries";

/**
 * What My Game Dex prepared for a new-game submission (M15 submission enrichment): the stored
 * lookup in approved sources, the catalog games it may duplicate, what the submission suggests,
 * and what the release still lacks before it can be published. Each line says what kind of
 * information it is: a source's claim, a suggestion, or missing. Nothing here is chosen,
 * copied into the record or published; the editor decides.
 */

const KINDS = {
  claim: { label: "Source claim", className: "bg-sky-500/15 text-foreground" },
  suggested: { label: "Suggested", className: "bg-amber-500/15 text-foreground" },
  missing: { label: "Missing", className: "bg-destructive/10 text-foreground" },
  catalog: { label: "In the catalog", className: "bg-secondary text-secondary-foreground" },
} as const;

function Kind({ kind }: { kind: keyof typeof KINDS }) {
  return <span className={`shrink-0 rounded-md px-1.5 py-0.5 text-xs font-medium ${KINDS[kind].className}`}>{KINDS[kind].label}</span>;
}

function Part({ title, kind, children }: { title: string; kind: keyof typeof KINDS; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-2">
      <h3 className="flex flex-wrap items-center gap-2 text-sm font-semibold">
        {title} <Kind kind={kind} />
      </h3>
      {children}
    </div>
  );
}

const utc = (iso: string) => `${new Date(iso).toISOString().slice(0, 16).replace("T", " ")} UTC`;

export function PreparedReview({
  requestId,
  waiting,
  enrichment,
  configured,
  release,
  formatName,
  publishable,
}: {
  requestId: string;
  /** The request still waits for a decision, so a new lookup may be asked for. */
  waiting: boolean;
  enrichment: StoredEnrichment | null | undefined;
  configured: boolean;
  release: ReviewRelease | null;
  formatName: (code: string) => string;
  publishable: (code: string) => boolean;
}) {
  const e = enrichment ?? null;
  const names = (ids: string[]) => (ids.length ? ids.map((q) => e?.labels[q] ?? q).join(", ") : null);
  const inCatalog = (qid: string) => (e?.catalog_items ?? []).filter((c) => c.external_id === qid);
  const shell = release && !publishable(release.media_format_code) ? suggestedShell(release.platform.slug, release.region_code) : null;
  const gaps = release ? publicationGaps(release, publishable) : [];
  // Games already named as using a candidate's item aren't listed again by title.
  const titleMatches = (e?.title_matches ?? []).filter((g) => !(e?.catalog_items ?? []).some((c) => c.game_id === g.game_id));

  return (
    <div className="flex flex-col gap-5 text-sm">
      <p className="text-muted-foreground">Gathered automatically when the game was submitted. Nothing here is decided, copied into the record or published.</p>

      <Part title="Wikidata" kind="claim">
        {enrichment === undefined ? (
          <p className="text-muted-foreground">The lookup can&apos;t be read right now.</p>
        ) : (
          <p>{storedSummary(e, configured)}</p>
        )}
        {e?.retrieved_at ? (
          <p className="text-xs text-muted-foreground">
            Looked up {utc(e.retrieved_at)}
            {e.looked_up_title ? ` as “${e.looked_up_title}”` : ""}.
          </p>
        ) : null}
        {e?.candidates.length ? (
          <ul className="flex flex-col gap-3">
            {e.candidates.map((c) => (
              <li key={c.external_id} className="rounded-lg border p-3">
                <p className="font-medium">
                  <a href={c.url} className="text-primary-text underline underline-offset-4" rel="noreferrer" target="_blank">
                    {c.title}
                  </a>{" "}
                  <span className="font-normal text-muted-foreground">
                    Wikidata {c.external_id}
                    {c.title_matches ? " · same title" : " · different title"}
                  </span>
                </p>
                <dl className="mt-2 grid gap-x-4 gap-y-1 sm:grid-cols-[minmax(0,10rem)_minmax(0,1fr)]">
                  <dt className="text-muted-foreground">Developer</dt>
                  <dd>{names(c.developers) ?? "Not known"}</dd>
                  <dt className="text-muted-foreground">Publisher</dt>
                  <dd>{names(c.publishers) ?? "Not known"}</dd>
                  <dt className="text-muted-foreground">Released on this platform</dt>
                  <dd>{sourceDate(c.platform_first_release?.value, c.platform_first_release?.precision) ?? "Not known"}</dd>
                  <dt className="text-muted-foreground">First released</dt>
                  <dd>{sourceDate(c.first_release?.value, c.first_release?.precision) ?? "Not known"}</dd>
                  <dt className="text-muted-foreground">Other titles</dt>
                  <dd>{c.titles.filter((t) => t !== c.title).concat(c.ja_titles).join(" · ") || "None known"}</dd>
                </dl>
                {inCatalog(c.external_id).length ? (
                  <p className="mt-2">
                    <Kind kind="catalog" /> This Wikidata item is already the source of{" "}
                    {inCatalog(c.external_id).map((g, i) => (
                      <span key={g.game_id}>
                        {i ? ", " : ""}
                        <Link href={`/admin/catalog/games/${g.game_id}`} className="font-medium text-primary-text underline underline-offset-4">
                          {g.title}
                        </Link>{" "}
                        ({catalogStatusLabel(g.status)})
                      </span>
                    ))}
                    : most likely a duplicate.
                  </p>
                ) : null}
                {c.flags.length ? (
                  <ul className="mt-2 flex list-disc flex-col gap-0.5 pl-5 text-muted-foreground">
                    {c.flags.map((f) => (
                      <li key={f}>{flagText(f).text}</li>
                    ))}
                  </ul>
                ) : null}
                <p className="mt-2 text-xs text-muted-foreground">
                  Retrieved {utc(c.retrieved_at)}
                  {c.revision ? `, revision ${c.revision}` : ""}. {c.licence}. A source&apos;s claim about the game, not evidence of this physical release.
                </p>
              </li>
            ))}
          </ul>
        ) : null}
        {waiting && e ? (
          <form id="lookup-again" action={lookUpSubmissionAgain}>
            <input type="hidden" name="request_id" value={requestId} />
            <Button type="submit" variant="secondary" size="sm" className="h-9">
              Look up again
            </Button>
          </form>
        ) : null}
      </Part>

      {titleMatches.length ? (
        <Part title="Catalog games with this title" kind="catalog">
          <ul className="flex flex-col gap-1">
            {titleMatches.map((g) => (
              <li key={g.game_id}>
                <Link href={`/admin/catalog/games/${g.game_id}`} className="font-medium text-primary-text underline underline-offset-4">
                  {g.title}
                </Link>{" "}
                <span className="text-muted-foreground">
                  ({catalogStatusLabel(g.status)}, {g.via === "title" ? "same title" : g.via === "alias" ? "an alias" : "one of its source titles"})
                </span>
              </li>
            ))}
          </ul>
        </Part>
      ) : null}

      {shell ? (
        <Part title="Suggested by the submission" kind="suggested">
          <p>
            Cartridge shell: <span className="font-medium">{formatName(shell)}</span>, the usual one for this region. An inference to check against the copy, not evidence: set
            it in the release record once confirmed.
          </p>
        </Part>
      ) : null}

      {release ? (
        <Part title="Still needed before it can be published" kind="missing">
          {gaps.length ? (
            <ul className="flex list-disc flex-col gap-0.5 pl-5">
              {gaps.map((g) => (
                <li key={g}>{g}</li>
              ))}
            </ul>
          ) : (
            <p className="text-muted-foreground">Nothing the database requires is missing. Physical-release evidence is still the editor&apos;s to check.</p>
          )}
        </Part>
      ) : null}
    </div>
  );
}
