/**
 * The exact source files the M15 SNES pilot may be staged from, by SHA-256 (verified read-only on
 * 2026-11-23 against the B1 run and docs/architecture/catalog-ingestion-m12c-b1.md). The pilot
 * stages only these: never a new fetch, never the superseded first entity fetch, never an edited
 * selection or set of notes. B1 keeps its own, unpinned workflow, exactly as before.
 *
 * The 34 editorial notes are recommendations a person proposed, not decisions: staging uses them
 * only to keep the 13 records they hold out of the batch. Every outcome is still a human's.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

export const PILOT_SOURCES = Object.freeze({
  /** wikidata-entities-snes-2026-11-20T22-45-42-949Z.json: 150 entities, the re-fetch B1 staged. */
  entities: "96a8ac561e5f96efe73bbb51815b38a400f7b8f5b6916894d4f58e9e3920da92",
  /** selection-snes-150.json: the frozen 150-id selection. */
  selection: "a3774c7b4772ede12d80acb551875c8bef430d1e203ff22af1ccbff2d8961f9c",
  /** docs/proposals/m12c-b1/editorial-review-snes-150.json: 34 editorial notes (13 holds). */
  notes: "c24d2a0a72e0ae2d423edafa672375a3aca12bc8491056108af8fab31e2f1c68",
  /** source-evidence/2026-11-19/wikidata-licensing.html: the reviewed Wikidata:Licensing page (CC0). */
  terms: "dd71f10437ee091f87f881f5269b69a72637b6a254469daf3d48813d8f82a5c5",
  /** wikidata-formats-2026-11-20T18-32-38-232Z.json: the distribution formats DISTRIBUTION_FORMAT_TABLE classifies. */
  formats: "93797a673e7717d1269c0766d748d682533d83bc10c3d61b4cadfecbb0bff1c7",
});

/** Files that must never be staged on the pilot, by hash, with why. */
export const PILOT_REFUSED = Object.freeze({
  "4e87b22e5abb962349b4774431d3f895132ae2fb17fb2e8af164b569f656d8cd": "the superseded first entity fetch (wikidata-entities-snes-2026-11-20T14-11-04-475Z.json)",
});

export const sha256File = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");

/**
 * Checks the given files (kind → path) against the pins. Returns the problems, empty when every
 * file is exactly the pinned one. `hash` is injectable for tests.
 */
export function pilotSourceProblems(files, hash = sha256File) {
  const problems = [];
  for (const [kind, path] of Object.entries(files)) {
    if (!Object.hasOwn(PILOT_SOURCES, kind)) {
      problems.push(`${kind}: not a pilot source`);
      continue;
    }
    if (!path || path === true) {
      problems.push(`${kind}: missing`);
      continue;
    }
    let actual;
    try {
      actual = hash(path);
    } catch {
      problems.push(`${kind}: can't be read`);
      continue;
    }
    if (Object.hasOwn(PILOT_REFUSED, actual)) problems.push(`${kind}: ${PILOT_REFUSED[actual]}, which the pilot never uses`);
    else if (actual !== PILOT_SOURCES[kind]) problems.push(`${kind}: sha256 ${actual.slice(0, 12)}… isn't the pinned ${PILOT_SOURCES[kind].slice(0, 12)}…`);
  }
  return problems;
}
