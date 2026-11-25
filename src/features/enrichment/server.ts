import "server-only";

import { lookUpWikidataGame, wikidataConfigured, wikidataLabels } from "./wikidata";

/**
 * The lookup for new-game submissions (M15 submission enrichment), run by the server after the
 * response: right after a collector submits or changes the title, and again, for anything still
 * waiting, when the submission, an editor's review or the review queue is opened.
 *
 * Claims and results go through claim_submission_enrichments and record_submission_enrichment,
 * which only service_role can execute (the server's SUPABASE_SECRET_KEY, as the avatar workflow):
 * a collector can never write a source claim. A claim carries a token, so a retry, a second
 * server or a late answer never records twice or over a newer title. One Wikidata request at a
 * time from this server; every failure is soft and leaves the submission as it is.
 */

type Claim = { submission_id: string; claim_id: string; title: string | null; platform: string | null; region?: string | null };

function serviceConfig() {
  const url = process.env.SUPABASE_URL?.replace(/\/$/, "");
  const key = process.env.SUPABASE_SECRET_KEY;
  return url && key ? { url, key } : null;
}

async function serviceRpc(name: string, args: Record<string, unknown>): Promise<unknown> {
  const config = serviceConfig();
  if (!config) return null;
  const response = await fetch(`${config.url}/rest/v1/rpc/${name}`, {
    method: "POST",
    headers: { apikey: config.key, Authorization: `Bearer ${config.key}`, "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify(args),
    cache: "no-store",
    signal: AbortSignal.timeout(10000),
  });
  if (!response.ok) throw new Error(`${name} failed with status ${response.status}.`);
  return response.json();
}

// One lookup at a time from this server process: Wikidata asks clients not to send parallel requests.
let queue: Promise<unknown> = Promise.resolve();
function serially<T>(task: () => Promise<T>): Promise<T> {
  const next = queue.then(task, task);
  queue = next.catch(() => undefined);
  return next;
}

async function lookUp(claim: Claim): Promise<void> {
  if (!claim.title || !claim.platform) return;
  const result = await serially(() => lookUpWikidataGame(claim.title!, claim.platform!, claim.region ?? null));
  // Switched off between the claim and now: nothing to record, the claim lapses and it waits.
  if (result.status === "not_configured") return;
  const ids = result.candidates.flatMap((c) => [...c.developers, ...c.publishers, ...c.release_dates.flatMap((d) => d.places)]);
  const labels = ids.length ? await serially(() => wikidataLabels(ids)) : {};
  await serviceRpc("record_submission_enrichment", {
    p_submission: claim.submission_id,
    p_claim: claim.claim_id,
    p_result: {
      status: result.status,
      title: claim.title,
      platform: claim.platform,
      retrieved_at: result.at,
      candidates: result.candidates.slice(0, 10),
      labels,
    },
  });
}

/**
 * Looks up what is due: one submission's, or up to `limit` waiting ones. Never throws. Nothing is
 * asked of Wikidata, and nothing claimed, until the operator has set the Wikidata contact.
 */
export async function runSubmissionEnrichment({ submissionId, limit = 1 }: { submissionId?: string; limit?: number }): Promise<void> {
  if (!wikidataConfigured() || !serviceConfig()) return;
  try {
    const claims = (await serviceRpc("claim_submission_enrichments", { p_submission: submissionId ?? null, p_limit: limit })) as Claim[] | null;
    for (const claim of Array.isArray(claims) ? claims : []) {
      try {
        await lookUp(claim);
      } catch (error) {
        console.error(`Submission lookup ${claim.submission_id} failed: ${error instanceof Error ? error.message : "unknown error"}`);
      }
    }
  } catch (error) {
    console.error(`Submission lookups couldn't be claimed: ${error instanceof Error ? error.message : "unknown error"}`);
  }
}

export { wikidataConfigured };
