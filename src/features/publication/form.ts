/**
 * Independent identity publication (M14c-3): the queue's filters and labels, the publish form's
 * reading, and its fixed messages. Pure, so it can be tested alone. The database decides who may
 * publish what (publish_game_identity); this only reads the form and words the answers.
 */

export const QUEUE_STATES = [
  { value: "ready", label: "Ready to publish" },
  { value: "awaiting_evidence", label: "Awaiting physical evidence" },
  { value: "evidence_outdated", label: "Evidence outdated" },
  { value: "verifier_gone", label: "Verifier unavailable" },
  { value: "blocked", label: "Blocked" },
  { value: "published", label: "Published" },
  { value: "all", label: "All" },
] as const;
export type QueueState = (typeof QUEUE_STATES)[number]["value"];

export function queueState(value: unknown): QueueState {
  return QUEUE_STATES.find((s) => s.value === value)?.value ?? "ready";
}

export const STATE_DETAILS: Record<Exclude<QueueState, "all">, string> = {
  ready: "Physical existence confirmed with evidence, for the game as it is now. An editor who didn't confirm it, and didn't create it, can publish it.",
  awaiting_evidence: "The game's identity is verified, but nobody has confirmed with evidence that a physical copy exists on this platform. It can't be published yet.",
  evidence_outdated: "The evidence was recorded for an earlier revision of the game. It has to be confirmed again before it can be published.",
  verifier_gone: "The account that confirmed the evidence no longer exists. It has to be confirmed again before it can be published.",
  blocked: "The game or pairing isn't in a state that can be published: its identity needs verifying again, or it left review.",
  published: "Public as an identity.",
};

export const BLOCK_LABELS: Record<string, string> = {
  game_unavailable: "The game isn't in review or public.",
  pairing_unavailable: "The pairing isn't in review.",
  game_not_verified: "The game's identity isn't verified at its current revision.",
  physical_evidence_unconfirmed: "Physical existence isn't confirmed with evidence.",
  verifier_gone: "Its verifier's account is gone.",
  evidence_outdated: "The evidence is for an earlier revision.",
  published: "Already public.",
};

export const YOU_LABELS: Record<string, string> = {
  you_confirmed: "You confirmed its evidence, so another editor publishes it.",
  you_created: "You created this record, so another editor publishes it.",
};

/** Every message the publish form can show, by a fixed code. */
export const PUBLISH_MESSAGES = {
  choose: "Choose at least one platform you may publish.",
  reason: "Give a reason for the record. Other catalog staff can see it.",
  reason_long: "The reason can be up to 500 characters.",
  confirm: "Confirm that you checked the evidence and want to publish.",
  changed: "This game changed since you opened it: its revision, evidence or publication state is different. Reload the page and check it again.",
  not_eligible: "One of the platforms you chose can't be published by you now. Reload the page and check it again.",
  not_permitted: "Only active catalog editors with a verified session can publish.",
  reauthenticate: "Publishing needs a recent verification with your authenticator.",
  own_record: "You created this game or pairing, or confirmed its evidence, so another editor publishes it.",
  not_verified: "A platform you chose isn't confirmed with evidence for the game as it is now.",
  game_not_verified: "The game's identity isn't verified at its current revision.",
  unavailable: "This game or pairing can't be published in its current state.",
  failed: "Nothing was published. Try again.",
} as const;
export type PublishMessage = keyof typeof PUBLISH_MESSAGES;

export function publishErrorCode(message: unknown): PublishMessage {
  const codes: Record<string, PublishMessage> = {
    "not permitted": "not_permitted",
    "reauthentication required": "reauthenticate",
    "own record": "own_record",
    "record changed": "changed",
    "pairing not verified": "not_verified",
    "game not verified": "game_not_verified",
    "record unavailable": "unavailable",
    "invalid changes": "choose",
    "reason required": "reason",
  };
  return typeof message === "string" && Object.hasOwn(codes, message) ? codes[message] : "failed";
}

export function publishMessage(code: string | null): string | null {
  return code && Object.hasOwn(PUBLISH_MESSAGES, code) ? PUBLISH_MESSAGES[code as PublishMessage] : null;
}

/**
 * The publish form, read: the platforms chosen (only ones the page offered: `allowed`), a typed
 * reason and the confirmation box. Nothing is chosen for the editor; every platform starts
 * unticked, and none is published that wasn't ticked.
 */
export function readPublish(platforms: string[], read: (name: string) => string, allowed: readonly string[]): { value: { platforms: string[]; reason: string } } | { error: PublishMessage } {
  const chosen = [...new Set(platforms.map((p) => p.trim()).filter(Boolean))];
  if (!chosen.length || chosen.length > 20) return { error: "choose" };
  if (chosen.some((p) => !allowed.includes(p))) return { error: "not_eligible" };
  const reason = read("reason").replace(/\s+/g, " ").trim();
  if (!reason) return { error: "reason" };
  if (reason.length > 500) return { error: "reason_long" };
  if (read("confirm") !== "on") return { error: "confirm" };
  return { value: { platforms: chosen, reason } };
}
