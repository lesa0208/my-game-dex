import Link from "next/link";
import type { ReactNode } from "react";

import { Button } from "@/components/ui/button";
import { CandidateCard } from "@/components/enrichment/source-candidate";
import { decisionSummary, publicationGaps, storedSummary, suggestedShell, undecided, type StoredEnrichment } from "@/features/enrichment/match";
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
  canDecide = false,
}: {
  requestId: string;
  /** The editor may confirm or reject a match (the game exists and can still take a source). */
  canDecide?: boolean;
  /** The request still waits for a decision, so a new lookup may be asked for. */
  waiting: boolean;
  enrichment: StoredEnrichment | null | undefined;
  configured: boolean;
  release: ReviewRelease | null;
  formatName: (code: string) => string;
  publishable: (code: string) => boolean;
}) {
  const e = enrichment ?? null;
  const shell = release && !publishable(release.media_format_code) ? suggestedShell(release.platform.slug, release.region_code) : null;
  const gaps = release ? publicationGaps(release, publishable) : [];
  // Games already named as using a candidate's item aren't listed again by title.
  const titleMatches = (e?.title_matches ?? []).filter((g) => !(e?.catalog_items ?? []).some((c) => c.game_id === g.game_id));

  return (
    <div className="flex flex-col gap-5 text-sm">
      <p className="text-muted-foreground">Gathered automatically when the game was submitted. Nothing here is copied into the record or published until an editor confirms a match, and even then nothing is verified.</p>

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
        {decisionSummary(e) ? <p className="font-medium">{decisionSummary(e)}</p> : null}
        {e?.candidates.length ? (
          <ul className="flex flex-col gap-3">
            {e.candidates.map((c) => (
              <CandidateCard key={c.external_id} c={c} e={e} decide={canDecide && e.game_id && undecided(e).includes(c) ? { requestId, gameId: e.game_id, back: "review" } : null} />
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
                  ({catalogStatusLabel(g.status)}, {g.via === "title" ? "same title" : g.via === "alias" ? "an alias" : "one of its source titles"}
                  {g.via_match ? ", matching one of the Wikidata match's other titles" : ""})
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
