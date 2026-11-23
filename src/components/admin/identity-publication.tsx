import { EditForm } from "@/components/admin/edit-form";
import { adminTextarea, AdminField } from "@/components/admin/form-controls";
import { RecordSection, StatusBadge } from "@/components/admin/records";
import { StepUpNotice } from "@/components/admin/review-panel";
import { publishIdentity, publishIdentityFromForm } from "@/features/publication/actions";
import { BLOCK_LABELS, YOU_LABELS } from "@/features/publication/form";
import type { GamePairingEvidence } from "@/features/records/queries";
import { formatWhen } from "@/features/submissions/display";

/**
 * Publishing a game's confirmed platform identities (M14c-3), on the staff game record. Each
 * pairing says whether it can be published now and by whom, as the database's evidence read
 * assesses it; only pairings the viewer may publish get a box, none ticked. publish_game_identity
 * checks everything again and decides. An identity is never a physical release.
 */
export function IdentityPublication({ evidence, recentMfa, path, error }: { evidence: GamePairingEvidence; recentMfa: boolean; path: string; error: string | null }) {
  const mine = evidence.pairings.filter((p) => p.publication.you_may_publish);
  const verifier = (v: { handle: string | null; you: boolean }) => (v.you ? "you" : v.handle ? `@${v.handle}` : "a former staff member");
  return (
    <RecordSection id="identity-publication" title="Identity publication">
      <div className="flex flex-col gap-4">
        <p className="text-sm">
          <span className="font-medium">Game identity:</span>{" "}
          {evidence.game.status === "published" ? "public." : evidence.game.identity_verified ? "verified at its current revision." : "not verified at its current revision."}{" "}
          <span className="text-muted-foreground">
            Publishing makes the game and the chosen platforms public as identities, with “No verified physical release recorded yet”. It never creates an edition, region,
            format, box, cartridge, disc or product code.
          </span>
        </p>
        <ul aria-label="Platforms and whether they can be published" className="flex flex-col gap-2">
          {evidence.pairings.map((p) => (
            <li key={p.platform.slug} className="flex flex-col gap-1 rounded-lg border p-3 text-sm">
              <span className="flex flex-wrap items-center gap-2 font-medium">
                {p.platform.name} <StatusBadge status={p.status} />
              </span>
              {p.physical ? (
                <span className="text-muted-foreground">
                  Physical existence confirmed by {verifier(p.physical.verifier)}, {formatWhen(p.physical.verified_at)}
                  {p.physical.note ? <span className="block whitespace-pre-line text-foreground/90">“{p.physical.note}”</span> : null}
                </span>
              ) : (
                <span className="text-muted-foreground">Physical existence not confirmed with evidence.</span>
              )}
              <span>
                {p.status === "published"
                  ? "Already public."
                  : !p.publication.eligible
                    ? `Can't be published yet: ${(p.publication.reason && BLOCK_LABELS[p.publication.reason]) ?? "its state doesn't allow it."}`
                    : p.publication.you_may_publish
                      ? "Ready: you may publish it."
                      : `Ready, for another editor. ${(p.publication.your_reason && YOU_LABELS[p.publication.your_reason]) ?? ""}`}
              </span>
            </li>
          ))}
        </ul>
        <div role="alert" aria-live="assertive">
          {error ? <p className="rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2.5 text-sm text-destructive">Nothing was published. {error}</p> : null}
        </div>
        {!mine.length ? (
          <p className="text-sm text-muted-foreground">There is nothing here you may publish now.</p>
        ) : !recentMfa ? (
          <StepUpNotice path={path}>Publishing needs a recent verification.</StepUpNotice>
        ) : (
          <EditForm id="publish-identity" recordId={evidence.game.id} action={publishIdentity} plain={publishIdentityFromForm} submit="Publish the chosen platforms" pending="Publishing…" variant="default">
            <input type="hidden" name="game_id" value={evidence.game.id} />
            <input type="hidden" name="seen_revision" value={evidence.game.revision} />
            <fieldset className="flex flex-col gap-2">
              <legend className="mb-1 text-sm font-medium">Platforms to publish</legend>
              {mine.map((p) => (
                <div key={p.platform.slug} className="flex items-center gap-3">
                  {/* When the evidence shown was recorded: publishing refuses if it was confirmed again since. */}
                  <input type="hidden" name={`seen_at_${p.platform.slug}`} value={p.physical?.verified_at ?? ""} />
                  <input id={`publish-${p.platform.slug}`} type="checkbox" name="platform" value={p.platform.slug} className="size-5 shrink-0 accent-primary-solid" />
                  <label htmlFor={`publish-${p.platform.slug}`} className="text-sm">
                    {p.platform.name}
                  </label>
                </div>
              ))}
            </fieldset>
            <AdminField id="publish-identity-reason" label="Reason, for the record" hint="Kept in the audit log. Visible to other catalog staff.">
              <textarea id="publish-identity-reason" name="reason" required maxLength={500} rows={2} autoComplete="off" aria-describedby="publish-identity-reason-hint" className={adminTextarea} />
            </AdminField>
            <div className="flex gap-3 rounded-lg border bg-muted/40 p-3">
              <input id="publish-identity-confirm" name="confirm" type="checkbox" required className="mt-0.5 size-5 shrink-0 accent-primary-solid" />
              <label htmlFor="publish-identity-confirm" className="text-sm">
                I checked the evidence recorded for each platform I chose, and I didn&apos;t confirm it myself. Publishing makes them public.
              </label>
            </div>
          </EditForm>
        )}
      </div>
    </RecordSection>
  );
}
