import Link from "next/link";

import { EditForm, ReasonField } from "@/components/admin/edit-form";
import { decideSourceMatch, decideSourceMatchFromForm } from "@/features/editing/actions";
import { PLACE_NAMES, matchText, regionalReleases, type EnrichmentCandidate, type StoredEnrichment } from "@/features/enrichment/match";
import { flagText, sourceDate } from "@/features/records/source-facts";
import { catalogStatusLabel } from "@/features/review/form";

/**
 * One Wikidata match a submission's lookup found (M15), as a source's claim: how it matches the
 * submitted title, what it says about the game and its regional releases, where it came from, and
 * (for a catalog editor) a confirm or reject with their own reason. Used on the submission's review
 * and on the game's record. Nothing here is a verified catalog fact.
 */

const utc = (iso: string) => `${new Date(iso).toISOString().slice(0, 16).replace("T", " ")} UTC`;
const REGION_WORDS: Record<string, string> = { pal: "PAL (Europe and Australia)", "ntsc-uc": "North America", "ntsc-j": "Japan" };

export function placeName(id: string, labels: Record<string, string>): string {
  return labels[id] ?? PLACE_NAMES[id] ?? id;
}

export function CandidateCard({
  c,
  e,
  decide,
}: {
  c: EnrichmentCandidate;
  e: Pick<StoredEnrichment, "labels" | "region" | "catalog_items" | "decisions" | "own_submission">;
  /** Shows the confirm and reject forms: the submission, its game and where to come back to. */
  decide?: { requestId: string; gameId: string; back: "game" | "review" } | null;
}) {
  const names = (ids: string[]) => (ids.length ? ids.map((q) => e.labels[q] ?? q).join(", ") : null);
  const inCatalog = (e.catalog_items ?? []).filter((g) => g.external_id === c.external_id);
  const regional = regionalReleases(c, e.region);
  const others = (c.release_dates ?? []).filter((d) => !regional.includes(d));
  const decision = e.decisions?.[c.external_id]?.decision ?? null;
  const formId = `${decide?.back ?? "card"}-${c.external_id}`;

  return (
    <li className="rounded-lg border border-dashed p-3" data-candidate={c.external_id}>
      <p className="flex flex-wrap items-baseline gap-x-2 gap-y-1 font-medium">
        <a href={c.url} className="text-primary-text underline underline-offset-4" rel="noreferrer" target="_blank">
          {c.title}
        </a>
        <span className="font-normal text-muted-foreground">Wikidata {c.external_id}</span>
        {c.likely ? <span className="rounded-md bg-sky-500/15 px-1.5 py-0.5 text-xs font-medium">Likely match</span> : null}
        {decision ? (
          <span className="rounded-md bg-secondary px-1.5 py-0.5 text-xs font-medium text-secondary-foreground">{decision === "confirmed" ? "Confirmed by an editor" : "Rejected by an editor"}</span>
        ) : null}
      </p>
      <p className="mt-1 text-muted-foreground">{matchText(c)}.</p>
      <dl className="mt-2 grid gap-x-4 gap-y-1 sm:grid-cols-[minmax(0,12rem)_minmax(0,1fr)]">
        <dt className="text-muted-foreground">Developer</dt>
        <dd>{names(c.developers) ?? "Not stated in Wikidata"}</dd>
        <dt className="text-muted-foreground">Publisher</dt>
        <dd>{names(c.publishers) ?? "Not stated in Wikidata"}</dd>
        {e.region && REGION_WORDS[e.region] ? (
          <>
            <dt className="text-muted-foreground">Released in the copy&apos;s region</dt>
            <dd>
              {regional.length
                ? regional.map((d) => `${sourceDate(d.value, d.precision)} (${d.places.map((p) => placeName(p, e.labels)).join(", ")})`).join(" · ")
                : `Not stated for ${REGION_WORDS[e.region]}`}
            </dd>
          </>
        ) : null}
        <dt className="text-muted-foreground">{regional.length || e.region ? "Other releases on this platform" : "Released on this platform"}</dt>
        <dd>
          {others.length
            ? others.map((d) => `${sourceDate(d.value, d.precision)}${d.places.length ? ` (${d.places.map((p) => placeName(p, e.labels)).join(", ")})` : ""}`).join(" · ")
            : (sourceDate(c.platform_first_release?.value, c.platform_first_release?.precision) ?? "Not stated")}
        </dd>
        <dt className="text-muted-foreground">Other titles</dt>
        <dd>{c.titles.filter((t) => t !== c.title).concat(c.ja_titles).join(" · ") || "None listed"}</dd>
      </dl>
      {inCatalog.length ? (
        <p className="mt-2">
          <span className="rounded-md bg-secondary px-1.5 py-0.5 text-xs font-medium text-secondary-foreground">In the catalog</span> This Wikidata item is already the source of{" "}
          {inCatalog.map((g, i) => (
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
      {decide && !decision && !inCatalog.length && e.own_submission ? (
        <p className="mt-3 border-t pt-3 text-muted-foreground">You submitted this game, so another catalog editor confirms or rejects its match.</p>
      ) : null}
      {decide && !decision && !inCatalog.length && !e.own_submission ? (
        <div className="mt-3 flex flex-col gap-3 border-t pt-3">
          <EditForm
            id={`confirm-${formId}`}
            recordId={decide.gameId}
            action={decideSourceMatch}
            plain={decideSourceMatchFromForm}
            submit="Confirm: this is the game"
            pending="Confirming…"
            variant="default"
          >
            <p className="text-muted-foreground">
              Confirming makes this item the game&apos;s source: its titles, developer, publisher and release dates appear on the record as the source&apos;s claims. Nothing is verified or
              published.
            </p>
            <input type="hidden" name="request_id" value={decide.requestId} />
            <input type="hidden" name="game_id" value={decide.gameId} />
            <input type="hidden" name="external_id" value={c.external_id} />
            <input type="hidden" name="decision" value="confirm" />
            <input type="hidden" name="back" value={decide.back} />
            <ReasonField id={`confirm-${formId}`} />
          </EditForm>
          <details>
            <summary className="cursor-pointer text-sm font-medium">Not this game? Reject it</summary>
            <div className="mt-3">
              <EditForm id={`reject-${formId}`} recordId={decide.gameId} action={decideSourceMatch} plain={decideSourceMatchFromForm} submit="Reject this match" pending="Rejecting…">
                <input type="hidden" name="request_id" value={decide.requestId} />
                <input type="hidden" name="game_id" value={decide.gameId} />
                <input type="hidden" name="external_id" value={c.external_id} />
                <input type="hidden" name="decision" value="reject" />
                <input type="hidden" name="back" value={decide.back} />
                <ReasonField id={`reject-${formId}`} />
              </EditForm>
            </div>
          </details>
        </div>
      ) : null}
    </li>
  );
}
