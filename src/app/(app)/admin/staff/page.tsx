import type { Metadata } from "next";

import { AdminCard, AdminFrame, AdminShell, PageMessage, param, ReasonInput } from "@/components/admin/admin-frame";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { grantRole, revokeRole } from "@/features/admin/actions";
import { ownerAuthorityBlocked, pageError, pageNotice, ROLES, roleLabel, statusLabel } from "@/features/admin/form";
import { getStaffMembers, requireAdminSection } from "@/features/admin/queries";

export const metadata: Metadata = {
  title: "Staff",
};

const selectClass =
  "h-10 w-full rounded-lg border border-input bg-transparent px-3 text-base outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring md:text-sm dark:bg-input/30";

async function StaffView({ searchParams }: { searchParams: PageProps<"/admin/staff">["searchParams"] }) {
  const search = await searchParams;
  const { viewer, access } = await requireAdminSection("/admin/staff", "admin");
  const members = await getStaffMembers();
  // The page mirrors the matrix (M8c); the database decides. Admin roles are the
  // Owner's to give, with Owner authority, and nobody changes their own or the Owner's.
  const grantable = ROLES.filter((r) => r !== "admin" || (access.owner && !ownerAuthorityBlocked(access.ownerAuthority)));

  return (
    <AdminFrame access={access} current="staff" title="Staff">
      <PageMessage notice={pageNotice(param(search.notice))} error={pageError(param(search.error))} />
      <AdminCard id="staff-list" title="Staff members">
        {!members ? (
          <p className="text-sm text-muted-foreground">The staff list isn&apos;t available right now. Try again later.</p>
        ) : (
          <ul className="flex flex-col divide-y">
            {members.map((m) => {
              const own = m.id === viewer.id;
              return (
                <li key={m.id} className="flex flex-col gap-2 py-3">
                  <p className="text-sm">
                    <span className="font-medium">{m.display_name ?? (m.handle ? `@${m.handle}` : "An account without a handle")}</span>
                    {m.handle && m.display_name ? <span className="text-muted-foreground"> @{m.handle}</span> : null}
                    {m.owner ? <span className="ml-2 rounded-md bg-secondary px-2 py-0.5 text-xs text-secondary-foreground">Owner</span> : null}
                    {m.successor ? <span className="ml-2 rounded-md border px-2 py-0.5 text-xs">Successor</span> : null}
                    {own ? <span className="ml-2 rounded-md border px-2 py-0.5 text-xs">You</span> : null}
                    {m.account_status !== "active" ? <span className="ml-2 text-xs text-destructive">{statusLabel(m.account_status)}</span> : null}
                  </p>
                  <ul className="flex flex-col gap-2">
                    {m.roles.map((role) => {
                      const removable = !own && !m.owner && (role !== "admin" || (access.owner && !ownerAuthorityBlocked(access.ownerAuthority)));
                      return (
                        <li key={role} className="flex flex-col gap-2 rounded-lg border p-2.5">
                          <span className="text-sm">{roleLabel(role)}</span>
                          {removable ? (
                            <form action={revokeRole} className="flex flex-col gap-2 sm:flex-row sm:items-end">
                              <input type="hidden" name="user_id" value={m.id} />
                              <input type="hidden" name="role" value={role} />
                              <input type="hidden" name="back" value="/admin/staff" />
                              <div className="min-w-0 flex-1">
                                <ReasonInput id={`revoke-${m.id}-${role}`} />
                              </div>
                              <Button type="submit" variant="destructive" size="lg" className="h-10 px-4">
                                Remove {roleLabel(role).toLowerCase()}
                              </Button>
                            </form>
                          ) : null}
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
          <div className="flex min-w-0 flex-col gap-1.5">
            <label htmlFor="grant-handle" className="text-sm font-medium">
              Handle
            </label>
            <Input id="grant-handle" name="handle" required maxLength={25} autoComplete="off" spellCheck={false} aria-describedby="grant-handle-hint" className="h-10" />
            <p id="grant-handle-hint" className="text-xs text-muted-foreground">
              The exact handle, without @. Only active, verified accounts can hold a role.
            </p>
          </div>
          <div className="flex min-w-0 flex-col gap-1.5">
            <label htmlFor="grant-role" className="text-sm font-medium">
              Role
            </label>
            <select id="grant-role" name="role" required className={selectClass}>
              {grantable.map((r) => (
                <option key={r} value={r}>
                  {roleLabel(r)}
                </option>
              ))}
            </select>
          </div>
          <ReasonInput id="grant-reason" />
          <div>
            <Button type="submit" size="lg" className="h-10 px-4">
              Give role
            </Button>
          </div>
        </form>
        {access.owner ? null : <p className="mt-3 text-sm text-muted-foreground">Only the Owner can make someone an administrator.</p>}
        {access.owner && ownerAuthorityBlocked(access.ownerAuthority) ? <p className="mt-3 text-sm text-muted-foreground">Administrator changes wait until Owner authority returns.</p> : null}
      </AdminCard>
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
