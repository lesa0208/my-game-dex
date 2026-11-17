import type { Metadata } from "next";
import Link from "next/link";

import { AdminCard, AdminFrame, AdminShell, linkClass, PageMessage, param, ReasonInput } from "@/components/admin/admin-frame";
import { AuditEntryItem } from "@/components/admin/audit-entry";
import { Cell, DataTable, StatusPill, when } from "@/components/admin/data-table";
import { Facts } from "@/components/admin/records";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { setAccountStatus } from "@/features/admin/actions";
import { AUTHORITY, ownerAuthorityBlocked, pageError, pageNotice, readHandle, readHandleQuery, roleLabel, statusLabel } from "@/features/admin/form";
import { type Account, type AdminAccess, getAccountSummary, requireAdminSection, searchAccounts } from "@/features/admin/queries";

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

const statusTone = (status: string) => (status === "active" ? "good" : "problem");
const times = (n: number, cap: number) => (n >= cap ? `${cap.toLocaleString("en")} or more times` : n === 1 ? "Once" : `${n.toLocaleString("en")} times`);

async function AccountsView({ searchParams }: { searchParams: PageProps<"/admin/accounts">["searchParams"] }) {
  const search = await searchParams;
  const { viewer, access } = await requireAdminSection("/admin/accounts", "moderator");
  const typed = param(search.handle);
  // An exact handle opens the account; otherwise, or when there's no such account,
  // the page lists the handles that start with what was typed.
  const handle = typed ? readHandle(typed) : null;
  const query = typed ? readHandleQuery(typed) : null;
  const summary = handle ? await getAccountSummary(handle) : null;
  const matches = query && (summary === null || !handle) ? await searchAccounts(query) : null;
  const account = summary && summary !== "error" ? summary.account : null;
  const back = account ? `/admin/accounts?handle=${account.handle}` : "/admin/accounts";
  const action = account ? statusAction(account, access, viewer.id) : null;

  return (
    <AdminFrame access={access} current="accounts" title="Accounts">
      <PageMessage notice={pageNotice(param(search.notice))} error={pageError(param(search.error))} />
      <AdminCard id="accounts-find" title="Find an account">
        <form method="get" action="/admin/accounts" role="search" aria-label="Find an account by handle" className="flex flex-col gap-2 sm:flex-row sm:items-end">
          <div className="flex min-w-0 flex-1 flex-col gap-1.5">
            <label htmlFor="account-handle" className="text-sm font-medium">
              Handle
            </label>
            <Input id="account-handle" name="handle" required maxLength={25} defaultValue={query ?? ""} autoComplete="off" spellCheck={false} aria-describedby="account-handle-hint" className="h-10" />
            <p id="account-handle-hint" className="text-xs text-muted-foreground">
              A handle, or its first letters. Accounts are found by handle only, never by email or name.
            </p>
          </div>
          <Button type="submit" variant="secondary" size="lg" className="h-10 px-4">
            Find
          </Button>
        </form>
      </AdminCard>
      <div role="alert" aria-live="assertive">
        {typed && !query ? <p className="text-sm text-destructive">Enter a handle: 2 to 24 letters, numbers or underscores.</p> : null}
      </div>
      {summary === "error" || matches === "error" ? <p className="text-sm text-muted-foreground">Accounts can&apos;t be looked up right now. Try again later.</p> : null}
      {handle && summary === null ? <p className="text-sm text-muted-foreground">No account has the handle @{handle}.</p> : null}
      {matches && matches !== "error" ? (
        <section aria-labelledby="account-matches-title" className="flex flex-col gap-2">
          <h2 id="account-matches-title" className="text-sm font-semibold">
            Handles that start with {query}
          </h2>
          {matches.length ? (
            <>
              <DataTable id="account-matches" caption={`Accounts whose handle starts with ${query}`} head={["Handle", "Name", "Status", "Roles"]}>
                {matches.map((m) => (
                  <tr key={m.id}>
                    <Cell header>
                      <Link href={`/admin/accounts?handle=${m.handle}`} className={linkClass}>
                        @{m.handle}
                      </Link>
                      {m.owner ? <span className="ml-2 text-xs text-muted-foreground">Owner</span> : null}
                    </Cell>
                    <Cell>{m.display_name ?? "Not set"}</Cell>
                    <Cell>
                      <StatusPill tone={statusTone(m.account_status)}>{statusLabel(m.account_status)}</StatusPill>
                    </Cell>
                    <Cell>{m.roles.length ? m.roles.map(roleLabel).join(", ") : "None"}</Cell>
                  </tr>
                ))}
              </DataTable>
              {matches.length === 25 ? <p className="text-xs text-muted-foreground">The first 25. Type more of the handle to narrow it.</p> : null}
            </>
          ) : (
            <p className="text-sm text-muted-foreground">No handle starts with {query}.</p>
          )}
        </section>
      ) : null}
      {account && summary && summary !== "error" ? (
        <>
          <AdminCard id="account-result" title={`@${account.handle}`}>
            <Facts
              label="Account"
              rows={[
                { label: "Name", value: account.display_name ?? "Not set" },
                { label: "Status", value: <StatusPill tone={statusTone(account.account_status)}>{statusLabel(account.account_status)}</StatusPill> },
                { label: "Roles", value: account.roles.length ? account.roles.map(roleLabel).join(", ") : "None" },
                { label: "Owner", value: account.owner ? "Yes. The Owner's account is protected." : null },
                { label: "Member since", value: new Date(account.member_since).toLocaleDateString("en", { dateStyle: "medium", timeZone: "UTC" }) },
              ]}
            />
            {action === "offer" ? (
              <form action={setAccountStatus} className="mt-4 flex flex-col gap-3">
                <input type="hidden" name="user_id" value={account.id} />
                <input type="hidden" name="status" value={account.account_status === "suspended" ? "active" : "suspended"} />
                <input type="hidden" name="back" value={back} />
                <ReasonInput id="status-reason" />
                <p className="text-xs text-muted-foreground">Kept in the audit log. A suspended account can sign in but can&apos;t change anything.</p>
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
                        ? access.owner
                          ? "Administrator changes wait until Owner authority returns."
                          : "Only the Owner can suspend an administrator."
                        : "Only an administrator can change the status of a staff member."}
              </p>
            )}
          </AdminCard>
          <AdminCard id="account-moderation" title="Moderation">
            <Facts
              label="Moderation"
              rows={[
                { label: "Suspended", value: summary.moderation.suspensions ? times(summary.moderation.suspensions, summary.cap) : "Never" },
                { label: "Reinstated", value: summary.moderation.reinstatements ? times(summary.moderation.reinstatements, summary.cap) : "Never" },
                { label: "Refused status changes", value: summary.moderation.refused_status_changes ? times(summary.moderation.refused_status_changes, summary.cap) : null },
                {
                  label: "Last status change",
                  value: summary.moderation.last_status_change
                    ? `${summary.moderation.last_status_change.action === "account_suspended" ? "Suspended" : "Reinstated"}${
                        summary.moderation.last_status_change.actor_handle ? ` by @${summary.moderation.last_status_change.actor_handle}` : ""
                      }, ${when(summary.moderation.last_status_change.at)}`
                    : null,
                },
              ]}
            />
            {access.admin ? (
              <p className="mt-3 text-sm">
                <Link href={`/admin/audit?target=${account.handle}`} className={linkClass}>
                  Every audit event about @{account.handle}
                </Link>
              </p>
            ) : null}
          </AdminCard>
          <section aria-labelledby="account-history-title" className="flex flex-col gap-2">
            <h2 id="account-history-title" className="text-sm font-semibold">
              Recent history
            </h2>
            <p className="text-xs text-muted-foreground">
              {access.admin ? "Status changes, staff roles and refused changes, newest first: the last 20." : "Status changes and refused status changes, newest first: the last 20."}
            </p>
            {summary.history.length ? (
              <ol className="flex flex-col gap-2">
                {summary.history.map((e) => (
                  <AuditEntryItem key={e.id} entry={e} auditLinks={access.admin} />
                ))}
              </ol>
            ) : (
              <p className="text-sm text-muted-foreground">Nothing has been recorded about this account.</p>
            )}
          </section>
        </>
      ) : null}
      <AdminCard id="accounts-authority" title="Who can do what">
        <Facts label="Who can do what" rows={AUTHORITY.map((a) => ({ label: a.role, value: a.can }))} />
      </AdminCard>
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
