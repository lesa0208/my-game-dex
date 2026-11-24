import { lookUpWikidataGame, wikidataLabels } from "@/features/enrichment/wikidata";
import { enrichmentSummary } from "@/features/enrichment/match";
import { sourceDate } from "@/features/records/source-facts";

/**
 * What approved external sources say about a submitted game (M15 catalog UX): Wikidata only,
 * looked up server-side when an editor opens the submission, and cached for a day. Each
 * candidate is a source's claim with its id, revision, licence scope and retrieval time; nothing
 * is chosen, copied into the record or published here. A failed or switched-off lookup changes
 * nothing about the submission.
 */
export async function ExternalSources({ title, platformSlug }: { title: string; platformSlug: string }) {
  const result = await lookUpWikidataGame(title, platformSlug);
  const ids = result.candidates.flatMap((c) => [...c.developers, ...c.publishers]);
  const labels = ids.length ? await wikidataLabels(ids) : {};
  const names = (list: string[]) => (list.length ? list.map((q) => labels[q] ?? q).join(", ") : "Not known");

  return (
    <div className="flex flex-col gap-3 text-sm">
      <p className={result.candidates.length ? "" : "text-muted-foreground"}>{enrichmentSummary(result)}</p>
      {result.candidates.length ? (
        <ul className="flex flex-col gap-3">
          {result.candidates.map((c) => (
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
                <dt className="text-muted-foreground">Released on this platform</dt>
                <dd>{sourceDate(c.platform_first_release?.value, c.platform_first_release?.precision) ?? "Not known"}</dd>
                <dt className="text-muted-foreground">First released</dt>
                <dd>{sourceDate(c.first_release?.value, c.first_release?.precision) ?? "Not known"}</dd>
                <dt className="text-muted-foreground">Developer</dt>
                <dd>{names(c.developers)}</dd>
                <dt className="text-muted-foreground">Publisher</dt>
                <dd>{names(c.publishers)}</dd>
                <dt className="text-muted-foreground">Other titles</dt>
                <dd>{c.titles.filter((t) => t !== c.title).concat(c.ja_titles).join(" · ") || "None known"}</dd>
              </dl>
              <p className="mt-2 text-xs text-muted-foreground">
                Retrieved {new Date(c.retrieved_at).toISOString().slice(0, 16).replace("T", " ")} UTC{c.revision ? `, revision ${c.revision}` : ""}. {c.licence}. A source&apos;s claim, not evidence
                of this physical release.
              </p>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
