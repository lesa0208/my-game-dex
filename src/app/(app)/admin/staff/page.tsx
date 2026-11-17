import type { Metadata } from "next";
import Link from "next/link";

import { AdminCard, AdminFrame, AdminShell, linkClass, PageMessage, param, ReasonInput } from "@/components/admin/admin-frame";
import { AuditEntryItem } from "@/components/admin/audit-entry";
import { StatusPill, when } from "@/components/admin/data-table";
import { Facts } from "@/components/admin/records";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { grantRole, revokeRole } from "@/features/admin/actions";
import { mfaReadiness, ownerAuthorityBlocked, pageError, pageNotice, ROLES, roleChangeBlocked, roleLabel, standingLabel } from "@/features/admin/form";
import { getStaffOverview, requireAdminSection } from "@/features/admin/queries";
import { adminControl, AdminField, adminSelect, FieldAction, FieldGrid, FormActions, InlineFieldRow } from "@/components/admin/form-controls";

export const metadata: Metadata = {
  title: "Staff",
};

async function StaffView({ searchParams }: { searchParams: PageProps<"/admin/staff">["searchParams"] }) {
  const search = await searchParams;
  const { viewer, access } = await requireAdminSection("/admin/staff", "admin");
  const overview = await getStaffOverview();
  // The page mirrors the matrix (M8c); the database decides. Admin roles are the
  // Owner's to give, with Owner authority, and nobody changes their own or the Owner's.
  const authorityBlocked = ownerAuthorityBlocked(access.ownerAuthority);
  const grantable = ROLES.filter((r) => r !== "admin" || (access.owner && !authorityBlocked));

  return (
    <AdminFrame access={access} current="staff" title="Staff">
      <PageMessage notice={pageNotice(param(search.notice))} error={pageError(param(search.error))} />
      {overview ? (
        <AdminCard id="staff-roles" title="Roles">
          <Facts
            label="Roles"
            rows={[
              { label: "Administrators", value: overview.roles.admin },
              { label: "Moderators", value: overview.roles.moderator },
              { label: "Catalog editors", value: overview.roles.catalog_editor },
            ]}
          />
          <p className="mt-3 text-xs text-muted-foreground">
            A role works only for an active account with a confirmed email address, signed in with a verified authenticator. Sensitive changes ask for a verification from the
            last 10 minutes.
          </p>
        </AdminCard>
      ) : null}
      <AdminCard id="staff-list" title="Staff members">
        {!overview ? (
          <p className="text-sm text-muted-foreground">The staff list isn&apos;t available right now. Try again later.</p>
        ) : overview.members.length === 0 ? (
          <p className="text-sm text-muted-foreground">Nobody holds a staff role.</p>
        ) : (
          <ul className="flex flex-col divide-y">
            {overview.members.map((m) => {
              const own = m.id === viewer.id;
              const standing = standingLabel(m.standing);
              const mfa = mfaReadiness(m);
              return (
                <li key={m.id} className="flex flex-col gap-2 py-3">
                  <p className="text-sm">
                    <span className="font-medium">{m.display_name ?? (m.handle ? `@${m.handle}` : "An account without a handle")}</span>
                    {m.handle && m.display_name ? <span className="text-muted-foreground"> @{m.handle}</span> : null}
                    {m.owner ? <span className="ml-2 rounded-md bg-secondary px-2 py-0.5 text-xs text-secondary-foreground">Owner</span> : null}
                    {m.successor ? <span className="ml-2 rounded-md border px-2 py-0.5 text-xs">Successor</span> : null}
                    {own ? <span className="ml-2 rounded-md border px-2 py-0.5 text-xs">You</span> : null}
                  </p>
                  <p className="flex flex-wrap items-center gap-2">
                    <StatusPill tone={standing.tone}>{standing.label}</StatusPill>
                    <StatusPill tone={mfa.tone}>{mfa.label}</StatusPill>
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {m.last_staff_action_at ? `Last recorded action ${when(m.last_staff_action_at)}.` : "No recorded actions."}
                    {m.handle ? (
                      <>
                        {" "}
                        <Link href={`/admin/accounts?handle=${m.handle}`} className="underline underline-offset-4">
                          Account
                        </Link>
                        {" · "}
                        <Link href={`/admin/audit?actor=${m.handle}`} className="underline underline-offset-4">
                          Their actions
                        </Link>
                      </>
                    ) : null}
                  </p>
                  <ul className="flex flex-col gap-2">
                    {m.roles.map((role) => {
                      const blocked = roleChangeBlocked({ own, owner: m.owner, role, viewerOwner: access.owner, ownerAuthorityBlocked: authorityBlocked });
                      return (
                        <li key={role} className="flex flex-col gap-2 rounded-lg border p-2.5">
                          <span className="text-sm">{roleLabel(role)}</span>
                          {blocked ? (
                            <p className="text-xs text-muted-foreground">{blocked}</p>
                          ) : (
                            <form action={revokeRole}>
                              <input type="hidden" name="user_id" value={m.id} />
                              <input type="hidden" name="role" value={role} />
                              <input type="hidden" name="back" value="/admin/staff" />
                              <InlineFieldRow>
                                <ReasonInput id={`revoke-${m.id}-${role}`} />
                                <FieldAction>
                                  <Button type="submit" variant="destructive" size="control">
                                    Remove {roleLabel(role).toLowerCase()}
                                  </Button>
                                </FieldAction>
                              </InlineFieldRow>
                            </form>
                          )}
                        </li>
                      );
                    })}
                  </ul>
                </li>
              );
            })}
          </ul>
        )}
      </AdminCard>
      <AdminCard id="staff-grant" title="Give a role">
        <form action={grantRole} className="flex flex-col gap-3">
          <input type="hidden" name="back" value="/admin/staff" />
          <FieldGrid>
            <AdminField id="grant-handle" label="Handle" hint="The exact handle, without @. Only active, verified accounts can hold a role.">
              <Input id="grant-handle" name="handle" required maxLength={25} autoComplete="off" spellCheck={false} aria-describedby="grant-handle-hint" className={adminControl} />
            </AdminField>
            <AdminField id="grant-role" label="Role">
              <select id="grant-role" name="role" required className={adminSelect}>
                {grantable.map((r) => (
                  <option key={r} value={r}>
                    {roleLabel(r)}
                  </option>
                ))}
              </select>
            </AdminField>
          </FieldGrid>
          <ReasonInput id="grant-reason" />
          <FormActions>
            <Button type="submit" size="control">
              Give role
            </Button>
          </FormActions>
        </form>
        {access.owner ? null : <p className="mt-3 text-sm text-muted-foreground">Only the Owner can make someone an administrator.</p>}
        {access.owner && authorityBlocked ? <p className="mt-3 text-sm text-muted-foreground">Administrator changes wait until Owner authority returns.</p> : null}
      </AdminCard>
      {overview ? (
        <section aria-labelledby="staff-recent-title" className="flex flex-col gap-2">
          <h2 id="staff-recent-title" className="text-sm font-semibold">
            Recent staff changes
          </h2>
          {overview.recent.length ? (
            <>
              <ol className="flex flex-col gap-2">
                {overview.recent.map((e) => (
                  <AuditEntryItem key={e.id} entry={e} auditLinks />
                ))}
              </ol>
              <p className="text-sm">
                <Link href="/admin/audit?kind=staff" className={linkClass}>
                  Every staff change
                </Link>
              </p>
            </>
          ) : (
            <p className="text-sm text-muted-foreground">No staff changes have been recorded.</p>
          )}
        </section>
      ) : null}
    </AdminFrame>
  );
}

export default function StaffPage({ searchParams }: PageProps<"/admin/staff">) {
  return (
    <AdminShell>
      <StaffView searchParams={searchParams} />
    </AdminShell>
  );
}
