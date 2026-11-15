import type { Metadata } from "next";

import { AdminCard, AdminFrame, AdminShell, PageMessage, param, ReasonInput } from "@/components/admin/admin-frame";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { setAccountStatus } from "@/features/admin/actions";
import { ownerAuthorityBlocked, pageError, pageNotice, readHandle, roleLabel, statusLabel } from "@/features/admin/form";
import { type Account, type AdminAccess, findAccount, requireAdminSection } from "@/features/admin/queries";

export const metadata: Metadata = {
  title: "Accounts",
};

/** What the page offers for an account, mirroring the matrix (M8c). The database decides. */
function statusAction(account: Account, access: AdminAccess, viewerId: string): "offer" | "self" | "owner" | "not_allowed" {
  if (account.id === viewerId) return "self";
  if (account.owner) return "owner";
  if (account.account_status === "deactivated") return "not_allowed";
  if (account.roles.includes("admin")) return access.owner && !ownerAuthorityBlocked(access.ownerAuthority) ? "offer" : "not_allowed";
  if (account.roles.length > 0) return access.admin ? "offer" : "not_allowed";
  return "offer";
}

async function AccountsView({ searchParams }: { searchParams: PageProps<"/admin/accounts">["searchParams"] }) {
  const search = await searchParams;
  const { viewer, access } = await requireAdminSection("/admin/accounts", "moderator");
  const typed = param(search.handle);
  const handle = typed ? readHandle(typed) : null;
  const account = handle ? await findAccount(handle) : null;
  const back = handle ? `/admin/accounts?handle=${handle}` : "/admin/accounts";
  const action = account && account !== "error" ? statusAction(account, access, viewer.id) : null;

  return (
    <AdminFrame access={access} current="accounts" title="Accounts">
      <PageMessage notice={pageNotice(param(search.notice))} error={pageError(param(search.error))} />
      <AdminCard id="accounts-find" title="Find an account">
        <form method="get" action="/admin/accounts" role="search" aria-label="Find an account by handle" className="flex flex-col gap-2 sm:flex-row sm:items-end">
          <div className="flex min-w-0 flex-1 flex-col gap-1.5">
            <label htmlFor="account-handle" className="text-sm font-medium">
              Handle
            </label>
            <Input id="account-handle" name="handle" required maxLength={25} defaultValue={handle ?? ""} autoComplete="off" spellCheck={false} aria-describedby="account-handle-hint" className="h-10" />
            <p id="account-handle-hint" className="text-xs text-muted-foreground">
              The exact handle. Accounts are found by handle only, never by email.
            </p>
          </div>
          <Button type="submit" variant="secondary" size="lg" className="h-10 px-4">
            Find
          </Button>
        </form>
      </AdminCard>
      {typed && !handle ? <p className="text-sm text-destructive">Enter a handle: 3 to 24 letters, numbers or underscores.</p> : null}
      {account === "error" ? <p className="text-sm text-muted-foreground">Accounts can&apos;t be looked up right now. Try again later.</p> : null}
      {handle && account === null ? <p className="text-sm text-muted-foreground">No account has the handle @{handle}.</p> : null}
      {account && account !== "error" ? (
        <AdminCard id="account-result" title={`@${account.handle}`}>
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-sm">
            <dt className="text-muted-foreground">Name</dt>
            <dd>{account.display_name ?? "Not set"}</dd>
            <dt className="text-muted-foreground">Status</dt>
            <dd>{statusLabel(account.account_status)}</dd>
            <dt className="text-muted-foreground">Roles</dt>
            <dd>{account.roles.length ? account.roles.map(roleLabel).join(", ") : "None"}</dd>
          </dl>
          {action === "offer" ? (
            <form action={setAccountStatus} className="mt-4 flex flex-col gap-3">
              <input type="hidden" name="user_id" value={account.id} />
              <input type="hidden" name="status" value={account.account_status === "suspended" ? "active" : "suspended"} />
              <input type="hidden" name="back" value={back} />
              <ReasonInput id="status-reason" />
              <div>
                <Button type="submit" variant={account.account_status === "suspended" ? "default" : "destructive"} size="lg" className="h-10 px-4">
                  {account.account_status === "suspended" ? "Reinstate account" : "Suspend account"}
                </Button>
              </div>
            </form>
          ) : (
            <p className="mt-4 text-sm text-muted-foreground">
              {action === "self"
                ? "You can't change your own account's status."
                : action === "owner"
                  ? "The Owner's account is protected and can't be suspended here."
                  : account.account_status === "deactivated"
                    ? "A deactivated account isn't managed here."
                    : account.roles.includes("admin")
                      ? "Only the Owner can suspend an administrator."
                      : "Only an administrator can change the status of a staff member."}
            </p>
          )}
        </AdminCard>
      ) : null}
    </AdminFrame>
  );
}

export default function AccountsPage({ searchParams }: PageProps<"/admin/accounts">) {
  return (
    <AdminShell>
      <AccountsView searchParams={searchParams} />
    </AdminShell>
  );
}
