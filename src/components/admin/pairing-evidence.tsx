import Link from "next/link";

import { linkClass } from "@/components/admin/admin-frame";
import { Facts, StatusBadge } from "@/components/admin/records";
import { formatDay } from "@/features/collection/details";
import type { PairingEvidence, PairingState, PublicationBlock } from "@/features/records/queries";
import { formatWhen } from "@/features/submissions/display";

/**
 * A game's platform pairings with what their physical existence rests on (M14c-1): read-only,
 * for catalog staff. Nothing here confirms, publishes or changes a record, and nothing is
 * inferred: a pairing without a recorded basis says so, and a release counts as verified only
 * when the catalog publishes it (published releases are always verified).
 */

const STATES: Record<PairingState, string> = {
  unconfirmed: "Physical existence not confirmed",
  confirmed: "Physical existence confirmed",
  published_identity: "Published identity, no verified release",
  published_with_release: "Published, with a verified release",
  closed: "Not in review",
};

const STATE_DETAILS: Record<PairingState, string> = {
  unconfirmed: "Not public. No editor has confirmed with evidence that a physical copy exists on this platform.",
  confirmed: "Not public yet. An editor confirmed its physical existence.",
  published_identity: "Public as an identity: “No verified physical release recorded yet”. No edition, region or format is implied.",
  published_with_release: "Public, through at least one verified, published physical release.",
  closed: "Not public, and not in review.",
};

const BLOCKS: Record<PublicationBlock, string> = {
  published: "Already public.",
  game_unavailable: "Not possible: the game isn't in review or public.",
  pairing_unavailable: "Not possible: the pairing isn't in review.",
  game_not_verified: "Not yet: the game's identity isn't verified at its current revision.",
  physical_evidence_unconfirmed: "Not yet: its physical existence hasn't been confirmed with evidence.",
  verifier_gone: "Not yet: the account that confirmed it no longer exists, so it needs to be confirmed again.",
  evidence_outdated: "Not yet: the evidence was recorded for an earlier revision of the game, so it needs to be confirmed again.",
};

const OUTCOMES = { correct: "found correct", incorrect: "found incorrect", excluded: "excluded" } as const;
const BATCH_STATUSES = { open: "Open", approved: "Approved", rejected: "Rejected" } as const;

function publicationText(p: PairingEvidence["publication"]): string {
  if (!p.eligible) return p.reason ? BLOCKS[p.reason] : "Not possible.";
  // Publishing also asks for a recent authenticator check; the record itself allows it.
  if (p.you_may_publish) return "Eligible. You may publish it.";
  if (p.your_reason === "you_confirmed") return "Eligible, by another editor: you confirmed its evidence, and whoever confirms evidence never publishes it.";
  if (p.your_reason === "you_created") return "Eligible, by another editor: you created this record.";
  return "Eligible, by another editor.";
}

function verifierText(v: NonNullable<PairingEvidence["physical"]>["verifier"]): string {
  if (v.you) return "You";
  return v.handle ? `@${v.handle}` : "A former staff member";
}

function releasesText(r: PairingEvidence["releases"]): string {
  if (r.total === 0) return "None recorded";
  const recorded = `${r.total.toLocaleString("en")} recorded`;
  return r.published ? `${recorded}, ${r.published.toLocaleString("en")} verified and published` : `${recorded}, none verified and published`;
}

function Batches({ batches }: { batches: PairingEvidence["batches"] }) {
  if (!batches.length) return null;
  return (
    <ul className="flex flex-col gap-1">
      {batches.map((b) => (
        <li key={b.id}>
          <Link href={`/admin/catalog/batches/${b.id}`} className={linkClass}>
            <code className="text-xs">{b.id.slice(0, 8)}</code>
          </Link>{" "}
          · {BATCH_STATUSES[b.status]}
          {b.decided_at ? ` ${formatDay(b.decided_at)}` : ""} ·{" "}
          {b.outcome
            ? `reviewed individually, ${OUTCOMES[b.outcome]}${b.recorded_at ? ` ${formatDay(b.recorded_at)}` : ""}`
            : !(b.sampled || b.flagged)
              ? "not sampled: never reviewed individually"
              : b.status === "open"
                ? "awaiting its individual review"
                : "not reviewed individually"}
        </li>
      ))}
    </ul>
  );
}

function Pairing({ pairing, gameRevision }: { pairing: PairingEvidence; gameRevision: number }) {
  const e = pairing.physical;
  const headingId = `pairing-${pairing.platform.slug}`;
  return (
    <li>
      <article aria-labelledby={headingId} className="flex flex-col gap-3 rounded-md border p-3">
        <header className="flex flex-col gap-1.5">
          <h3 id={headingId} className="flex flex-wrap items-center gap-2 text-sm font-semibold">
            {pairing.platform.name} <StatusBadge status={pairing.status} />
          </h3>
          <p className="text-sm">
            <span className="font-medium">{STATES[pairing.state]}.</span> <span className="text-muted-foreground">{STATE_DETAILS[pairing.state]}</span>
          </p>
        </header>
        <Facts
          label={`${pairing.platform.name}: physical evidence`}
          rows={[
            {
              label: "Physical existence",
              // Publication needs the evidence to be for the game's current revision; once public,
              // later edits move the revision on without unconfirming anything.
              value: !e
                ? "Not confirmed: no evidence recorded"
                : e.current || pairing.status === "published"
                  ? "Confirmed with evidence"
                  : `Confirmed for revision ${e.verified_game_revision ?? "unknown"}; the game is now at revision ${gameRevision}, so it needs confirming again before publication`,
            },
            { label: "Evidence source", value: e ? (e.source ?? "Not recorded") : null },
            { label: "Evidence reference", value: e ? (e.reference ?? "Not recorded") : null },
            {
              label: "Evidence note",
              value: e ? e.note ? <span className="whitespace-pre-line">{e.note}</span> : "Not recorded" : null,
            },
            { label: "Source snapshot", value: e?.snapshot_sha256 ? <code className="text-xs break-all">{e.snapshot_sha256}</code> : null },
            { label: "Verified by", value: e ? verifierText(e.verifier) : null },
            { label: "Verified", value: e ? formatWhen(e.verified_at) : null },
            { label: "Review batches", value: pairing.batches.length ? <Batches batches={pairing.batches} /> : null },
            { label: "Physical releases", value: releasesText(pairing.releases) },
            { label: "Identity publication", value: publicationText(pairing.publication) },
          ]}
        />
        {e?.batch_id ? (
          <p className="text-xs text-muted-foreground">
            Confirmed in review batch <code>{e.batch_id.slice(0, 8)}</code>: the source and reference name the record the reviewer checked, and the note is their own evidence. A provider listing alone is never evidence.
          </p>
        ) : null}
      </article>
    </li>
  );
}

export function PairingEvidenceList({ pairings, gameRevision }: { pairings: PairingEvidence[]; gameRevision: number }) {
  if (!pairings.length) return <p className="text-sm text-muted-foreground">It isn&apos;t paired with a platform yet.</p>;
  return (
    <ul aria-label="Platform pairings" className="flex flex-col gap-3">
      {pairings.map((p) => (
        <Pairing key={p.platform.slug} pairing={p} gameRevision={gameRevision} />
      ))}
    </ul>
  );
}
