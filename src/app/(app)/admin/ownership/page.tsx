import type { Metadata } from "next";

import { AdminCard, AdminFrame, AdminShell, PageMessage, param, ReasonInput } from "@/components/admin/admin-frame";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { acceptTransfer, cancelRecovery, cancelTransfer, registerDocument, setSuccessor, startTransfer } from "@/features/admin/actions";
import { ownerAuthorityBlocked, pageError, pageNotice, refusalMessage } from "@/features/admin/form";
import { getOwnershipStatus, requireAdminSection } from "@/features/admin/queries";
import { cn } from "@/lib/utils";
import { adminControl } from "@/components/admin/form-controls";

export const metadata: Metadata = {
  title: "Ownership",
};

function when(at: string): string {
  return new Date(at).toLocaleString("en", { dateStyle: "medium", timeStyle: "short", timeZone: "UTC" }) + " UTC";
}

function HandleInput({ id, required = true }: { id: string; required?: boolean }) {
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <label htmlFor={id} className="text-sm font-medium">
        Administrator&apos;s handle
      </label>
      <Input id={id} name="handle" required={required} maxLength={25} autoComplete="off" spellCheck={false} className={adminControl} />
    </div>
  );
}

async function OwnershipView({ searchParams }: { searchParams: PageProps<"/admin/ownership">["searchParams"] }) {
  const search = await searchParams;
  const { access } = await requireAdminSection("/admin/ownership", "admin");
  const status = await getOwnershipStatus();
  const blocked = ownerAuthorityBlocked(access.ownerAuthority);

  return (
    <AdminFrame access={access} current="ownership" title="Ownership">
      <PageMessage notice={pageNotice(param(search.notice))} error={pageError(param(search.error))} />
      {status === "error" ? (
        <p className="text-sm text-muted-foreground">Ownership can&apos;t be read right now. Try again later.</p>
      ) : status === null ? (
        <AdminCard id="ownership-none" title="No Owner yet">
          <p className="text-sm">The Owner is assigned by an operator, following the documented procedure. Nothing can assign one from here.</p>
        </AdminCard>
      ) : (
        <>
          <AdminCard id="ownership-status" title="The Owner">
            <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-sm">
              <dt className="text-muted-foreground">Owner</dt>
              <dd>
                {status.owner.display_name ?? "Not set"} {status.owner.handle ? `@${status.owner.handle}` : ""}
              </dd>
              <dt className="text-muted-foreground">Since</dt>
              <dd>{when(status.assigned_at)}</dd>
              <dt className="text-muted-foreground">Successor</dt>
              <dd>{status.successor_handle ? `@${status.successor_handle}` : "None named"}</dd>
              <dt className="text-muted-foreground">Succession document</dt>
              <dd>{status.document_registered_at ? `Registered ${when(status.document_registered_at)}` : "None registered"}</dd>
            </dl>
            {status.security_changed ? (
              <p className="mt-3 text-sm">The Owner&apos;s authenticator factors changed in the last 24 hours. If that wasn&apos;t expected, tell an operator.</p>
            ) : null}
            <p className="mt-3 text-xs text-muted-foreground">The successor gains nothing by being named. It&apos;s only the default choice in an operator&apos;s recovery.</p>
          </AdminCard>

          {status.recovery ? (
            <AdminCard id="ownership-recovery" title="Recovery in progress">
              <p className="text-sm">
                An operator opened a {status.recovery.kind === "reassign" ? "reassignment of ownership" : "reset of the Owner's authenticator factors"} on {when(status.recovery.created_at)}.
                It can complete after {when(status.recovery.hold_until)}
                {status.recovery.kind === "reassign" ? `, if @${status.recovery.target_handle ?? "the target"} has confirmed it (${status.recovery.confirmed ? "confirmed" : "not confirmed yet"})` : ""}.
                {status.recovery.disputed ? " It's disputed: only an operator can cancel it." : ""}
              </p>
              {access.owner && !status.recovery.disputed ? (
                <form action={cancelRecovery} className="mt-3 flex flex-col gap-3">
                  <input type="hidden" name="recovery_id" value={status.recovery.id} />
                  <p className="text-sm">If you didn&apos;t ask for this, cancel it. You need a fresh verification with your authenticator.</p>
                  <ReasonInput id="recovery-reason" />
                  <div>
                    <Button type="submit" variant="destructive" size="control">
                      Cancel the recovery
                    </Button>
                  </div>
                </form>
              ) : null}
            </AdminCard>
          ) : null}

          {status.transfer ? (
            <AdminCard id="ownership-transfer" title="Transfer waiting">
              <p className="text-sm">
                @{status.transfer.from_handle ?? "the Owner"} offered ownership to @{status.transfer.to_handle ?? "an account"} on {when(status.transfer.created_at)}.{" "}
                {status.transfer.expired ? "It has expired." : `It expires ${when(status.transfer.expires_at)}.`}
              </p>
              {access.transferOffered?.id === status.transfer.id ? (
                <div className="mt-3 flex flex-col gap-4">
                  <form action={acceptTransfer} className="flex flex-col gap-2">
                    <input type="hidden" name="transfer_id" value={status.transfer.id} />
                    <p className="text-sm">Accepting makes you the Owner. The current Owner stays an administrator. You need two verified authenticator factors and a fresh verification.</p>
                    <div>
                      <Button type="submit" size="control">
                        Accept ownership
                      </Button>
                    </div>
                  </form>
                  <form action={cancelTransfer} className="flex flex-col gap-3">
                    <input type="hidden" name="transfer_id" value={status.transfer.id} />
                    <input type="hidden" name="as" value="target" />
                    <ReasonInput id="decline-reason" />
                    <div>
                      <Button type="submit" variant="secondary" size="control">
                        Decline
                      </Button>
                    </div>
                  </form>
                </div>
              ) : access.owner ? (
                <form action={cancelTransfer} className="mt-3 flex flex-col gap-3">
                  <input type="hidden" name="transfer_id" value={status.transfer.id} />
                  <ReasonInput id="cancel-transfer-reason" />
                  <div>
                    <Button type="submit" variant="secondary" size="control">
                      Cancel the transfer
                    </Button>
                  </div>
                </form>
              ) : null}
            </AdminCard>
          ) : null}

          {access.owner ? (
            blocked ? (
              <AdminCard id="ownership-paused" title="Owner actions">
                <p className="text-sm">{refusalMessage(access.ownerAuthority)} Your account stays protected, and ordinary administrator work goes on.</p>
              </AdminCard>
            ) : (
              <>
                {!status.transfer ? (
                  <AdminCard id="ownership-offer" title="Offer ownership">
                    <form action={startTransfer} className="flex flex-col gap-3">
                      <p className="text-sm">Offer ownership to another administrator with two verified authenticator factors. They have 72 hours to accept, and you stay an administrator.</p>
                      <HandleInput id="transfer-handle" />
                      <ReasonInput id="transfer-reason" />
                      <div>
                        <Button type="submit" size="control">
                          Offer ownership
                        </Button>
                      </div>
                    </form>
                  </AdminCard>
                ) : null}
                <AdminCard id="ownership-successor" title="Successor">
                  <form action={setSuccessor} className="flex flex-col gap-3">
                    <HandleInput id="successor-handle" />
                    <ReasonInput id="successor-reason" />
                    <div>
                      <Button type="submit" variant="secondary" size="control">
                        Name successor
                      </Button>
                    </div>
                  </form>
                  {status.successor_handle ? (
                    <form action={setSuccessor} className="mt-4 flex flex-col gap-3">
                      <input type="hidden" name="clear" value="yes" />
                      <ReasonInput id="successor-clear-reason" />
                      <div>
                        <Button type="submit" variant="ghost" size="control">
                          Remove successor
                        </Button>
                      </div>
                    </form>
                  ) : null}
                </AdminCard>
                <AdminCard id="ownership-document" title="Succession document">
                  <form action={registerDocument} className="flex flex-col gap-3">
                    <div className="flex min-w-0 flex-col gap-1.5">
                      <label htmlFor="document-fingerprint" className="text-sm font-medium">
                        SHA-256 fingerprint
                      </label>
                      <Input id="document-fingerprint" name="fingerprint" required maxLength={80} autoComplete="off" spellCheck={false} aria-describedby="document-fingerprint-hint" className={cn(adminControl, "font-mono")} />
                      <p id="document-fingerprint-hint" className="text-xs text-muted-foreground">
                        64 hexadecimal digits. The document itself stays with its custodians, never here.
                      </p>
                    </div>
                    <ReasonInput id="document-reason" />
                    <div>
                      <Button type="submit" variant="secondary" size="control">
                        Register fingerprint
                      </Button>
                    </div>
                  </form>
                </AdminCard>
              </>
            )
          ) : null}
        </>
      )}
    </AdminFrame>
  );
}

export default function OwnershipPage({ searchParams }: PageProps<"/admin/ownership">) {
  return (
    <AdminShell>
      <OwnershipView searchParams={searchParams} />
    </AdminShell>
  );
}
