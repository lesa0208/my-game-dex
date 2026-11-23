/**
 * The decisions behind `catalog-b1-review.mjs publish` (M14c-3), apart from its prompts and its
 * B1-only guard, so they can be tested alone (scripts/publish-plan.test.mjs). Nothing here talks
 * to a database: it reads get_game_pairing_evidence's answer, as the editor's session got it.
 * publish_game_identity decides; this only refuses early, and explains.
 */

const REASONS = {
  published: "already public",
  game_unavailable: "the game isn't in review or public",
  pairing_unavailable: "the pairing isn't in review",
  game_not_verified: "the game's identity isn't verified at its current revision",
  physical_evidence_unconfirmed: "physical existence isn't confirmed with evidence",
  verifier_gone: "its verifier's account is gone: it needs confirming again",
  evidence_outdated: "the evidence is for an earlier revision: it needs confirming again",
};
const YOURS = {
  you_confirmed: "you confirmed its evidence, so another editor publishes it",
  you_created: "you created this record, so another editor publishes it",
};

/** Each pairing, in words: where it stands, and whether this editor may publish it now. */
export function describePairings(evidence) {
  return (evidence?.pairings ?? []).map((p) => {
    const physical = p.physical
      ? `confirmed by ${p.physical.verifier?.you ? "you" : p.physical.verifier?.handle ? `@${printable(p.physical.verifier.handle, 40)}` : "a former staff member"}`
        + `${p.physical.note ? `: "${printable(p.physical.note, 200)}"` : ""}`
      : "physical existence not confirmed";
    const standing = p.publication?.you_may_publish
      ? "you may publish it"
      : p.publication?.eligible
        ? `ready, for another editor: ${YOURS[p.publication.your_reason] ?? "not you"}`
        : `can't be published: ${REASONS[p.publication?.reason] ?? "its state doesn't allow it"}`;
    return { slug: p.platform.slug, name: printable(p.platform.name, 80), status: p.status, physical, standing, mayPublish: p.publication?.you_may_publish === true };
  });
}

/**
 * The platforms the editor typed (comma-separated slugs), checked against what they may publish
 * now. Nothing is chosen for them: an empty answer publishes nothing.
 */
export function choosePlatforms(answer, evidence) {
  const wanted = [...new Set(String(answer ?? "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean))];
  if (!wanted.length) return { error: "No platform chosen. Nothing was published." };
  const pairings = describePairings(evidence);
  for (const slug of wanted) {
    const p = pairings.find((x) => x.slug === slug);
    if (!p) return { error: `${slug} isn't one of this game's platforms. Nothing was published.` };
    if (!p.mayPublish) return { error: `${p.name}: ${p.standing}. Nothing was published.` };
  }
  return { slugs: wanted };
}

/** The confirmation the editor types: the game's first 8 characters. */
export const confirmsGame = (typed, gameId) => typeof typed === "string" && typeof gameId === "string" && typed.trim() === gameId.slice(0, 8);

/** publish_game_identity's answer, reported as it is: success only when the database said so. */
export function reportPublish(result) {
  if (result?.ok && result.data === true) return { ok: true, message: "Published. The game and the chosen platforms are public as identities; no physical release was created." };
  const reason = typeof result?.error === "string" ? result.error : "no answer";
  return { ok: false, message: `Refused: ${reason}. Nothing was published.` };
}

/** Text from the catalog for a terminal: control characters (escape sequences included) removed, bounded. */
export function printable(text, max = 300) {
  return String(text ?? "").replace(/[\u0000-\u001f\u007f-\u009f\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, "").slice(0, max);
}

/** When each chosen platform's evidence was recorded, as the editor was shown it (for publish_game_identity_as_seen). */
export function verifiedAt(evidence, slugs) {
  return slugs.map((slug) => (evidence?.pairings ?? []).find((p) => p.platform.slug === slug)?.physical?.verified_at ?? null);
}
