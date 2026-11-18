import type { Metadata } from "next";
import Link from "next/link";

import { AdminCard, AdminFrame, AdminShell, linkClass, PageMessage, param, ReasonInput } from "@/components/admin/admin-frame";
import { adminControl, AdminField, FormActions, InlineFieldRow, FieldAction } from "@/components/admin/form-controls";
import { StatusPill, when } from "@/components/admin/data-table";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { requireAdminSection } from "@/features/admin/queries";
import { authAdminConfigured } from "@/features/auth-admin/server";
import { createInvitation, resendInvitation, retryRevocation, revokeInvitation } from "@/features/invitations/actions";
import { INVITATION_STATUSES, invitationActions, invitationError, invitationNotice } from "@/features/invitations/form";
import { getInvitations } from "@/features/invitations/queries";

export const metadata: Metadata = {
  title: "Invitations",
};

/**
 * Invitations to the private beta (M11a-1), for administrators. Addresses are masked
 * once recorded; every action asks for a reason and a recent verification, and the
 * database decides each one again.
 */
async function InvitationsView({ searchParams }: { searchParams: PageProps<"/admin/invitations">["searchParams"] }) {
  const search = await searchParams;
  const { access } = await requireAdminSection("/admin/invitations", "admin");
  const list = await getInvitations(param(search.before));
  const configured = authAdminConfigured();
  const last = list && list.invitations.length === 50 ? list.invitations[list.invitations.length - 1].id : null;

  return (
    <AdminFrame access={access} current="invitations" title="Invitations">
      <p className="text-sm text-muted-foreground">
        The private beta is invitation only. An invitation lets one person create a collector account: never a staff role. Their link works once, for an hour; after that, resend
        it. Revoking never deletes an account. See{" "}
        <Link href="/admin/audit?category=accounts" className={linkClass}>
          account events
        </Link>{" "}
        in the audit log.
      </p>
      <PageMessage notice={invitationNotice(param(search.notice))} error={invitationError(param(search.error))} />
      <AdminCard id="invitations-new" title="Invite someone">
        {configured ? (
          <form action={createInvitation} className="flex flex-col gap-4">
            <AdminField id="invite-email" label="Email address" hint="Only sent on this local stack, to Mailpit. Shown masked once recorded.">
              <Input id="invite-email" name="email" type="email" required maxLength={254} autoComplete="off" spellCheck={false} aria-describedby="invite-email-hint" className={adminControl} />
            </AdminField>
            <ReasonInput id="invite-reason" />
            <FormActions>
              <Button type="submit" size="control">
                Send invitation
              </Button>
            </FormActions>
          </form>
        ) : (
          <p className="text-sm text-muted-foreground">
            Invitations can&apos;t be sent from this server: it has no Auth admin key configured. They work on the isolated test stack; see the README.
          </p>
        )}
        {list ? (
          <p className="mt-4 text-xs text-muted-foreground">
            Open invitations: yours {list.limits.mine} of {list.limits.mine_max}, everyone&apos;s {list.limits.total} of {list.limits.total_max}.
          </p>
        ) : null}
      </AdminCard>
      <section aria-labelledby="invitations-list-title" className="flex flex-col gap-3">
        <h2 id="invitations-list-title" className="text-base font-semibold tracking-tight">
          Invitations, newest first
        </h2>
        {!list ? (
          <p className="text-sm text-muted-foreground">Invitations can&apos;t be read right now. Try again later.</p>
        ) : list.invitations.length === 0 ? (
          <p className="text-sm text-muted-foreground">{param(search.before) ? "No older invitations." : "Nobody has been invited yet."}</p>
        ) : (
          <ul className="flex flex-col gap-3">
            {list.invitations.map((i) => {
              const status = INVITATION_STATUSES[i.status];
              const can = invitationActions(i.status);
              return (
                <li key={i.id} className="rounded-xl border bg-card p-4 sm:p-5">
                  <p className="flex flex-wrap items-center gap-2 text-sm">
                    <span className="font-medium">{i.email}</span>
                    <StatusPill tone={status.tone}>{status.label}</StatusPill>
                  </p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {status.hint} Invited {when(i.created_at)}
                    {i.invited_by ? ` by @${i.invited_by}` : ""}
                    {i.last_sent_at ? `; last email ${when(i.last_sent_at)}` : ""}
                    {i.revoked_at ? `; revoked ${when(i.revoked_at)}` : ""}.
                  </p>
                  {can.resend && configured ? (
                    i.resends_left > 0 ? (
                      !i.resend_ready ? (
                        <p className="mt-3 text-xs text-muted-foreground">It can be resent after {when(i.next_resend_at)}.</p>
                      ) : (
                        <form action={resendInvitation} className="mt-3">
                          <input type="hidden" name="invitation_id" value={i.id} />
                          <InlineFieldRow>
                            <ReasonInput id={`resend-${i.id}`} />
                            <FieldAction>
                              <Button type="submit" variant="secondary" size="control">
                                Resend ({i.resends_left} left)
                              </Button>
                            </FieldAction>
                          </InlineFieldRow>
                        </form>
                      )
                    ) : (
                      <p className="mt-3 text-xs text-muted-foreground">It has been resent five times, the most allowed.</p>
                    )
                  ) : null}
                  {can.revoke ? (
                    <form action={revokeInvitation} className="mt-3">
                      <input type="hidden" name="invitation_id" value={i.id} />
                      <InlineFieldRow>
                        <ReasonInput id={`revoke-${i.id}`} />
                        <FieldAction>
                          <Button type="submit" variant="destructive" size="control">
                            Revoke
                          </Button>
                        </FieldAction>
                      </InlineFieldRow>
                    </form>
                  ) : null}
                  {can.retry ? (
                    <form action={retryRevocation} className="mt-3">
                      <input type="hidden" name="invitation_id" value={i.id} />
                      <Button type="submit" variant="destructive" size="control">
                        Retry the revocation
                      </Button>
                    </form>
                  ) : null}
                  {i.status === "active" ? (
                    <p className="mt-3 text-xs">
                      <Link href="/admin/accounts" className={linkClass}>
                        Manage accounts
                      </Link>
                    </p>
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}
        {last ? (
          <p>
            <Button asChild variant="outline" size="control">
              <Link href={`/admin/invitations?before=${last}`}>Older</Link>
            </Button>
          </p>
        ) : null}
      </section>
    </AdminFrame>
  );
}

export default function InvitationsPage({ searchParams }: PageProps<"/admin/invitations">) {
  return (
    <AdminShell>
      <InvitationsView searchParams={searchParams} />
    </AdminShell>
  );
}
