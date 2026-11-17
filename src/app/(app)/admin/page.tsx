import { KeyRound } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import type { ReactNode } from "react";

import { AdminCard, AdminFrame, AdminShell, linkClass } from "@/components/admin/admin-frame";
import { ownerAuthorityBlocked, refusalMessage, roleLabel } from "@/features/admin/form";
import { getAdminOverview, requireAdminSection } from "@/features/admin/queries";
import { formatDay } from "@/features/collection/details";

export const metadata: Metadata = {
  title: "Admin",
};

/** A count as text; at the database's cap it says so instead of claiming an exact number. */
function count(n: number, cap: number): string {
  return n >= cap ? `${cap.toLocaleString("en")} or more` : n.toLocaleString("en");
}

/** A list of labelled counts, each optionally linked to the page that shows them. */
function Counts({ label, rows }: { label: string; rows: { label: string; value: string; href?: string }[] }) {
  return (
    <dl aria-label={label} className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-4 gap-y-1.5 text-sm">
      {rows.map((row) => (
        <div key={row.label} className="contents">
          <dt className="min-w-0">
            {row.href ? (
              <Link href={row.href} className={linkClass}>
                {row.label}
              </Link>
            ) : (
              row.label
            )}
          </dt>
          <dd className="text-right font-medium tabular-nums">{row.value}</dd>
        </div>
      ))}
    </dl>
  );
}

function Note({ children }: { children: ReactNode }) {
  return <p className="mt-3 text-sm text-muted-foreground">{children}</p>;
}

async function OverviewView() {
  const { access } = await requireAdminSection("/admin", "staff");
  // Counts come from the database, scoped by the caller's roles there (M10a).
  const overview = await getAdminOverview();
  const cap = overview?.cap ?? 0;
  const catalog = overview?.catalog ?? null;
  const accounts = overview?.accounts ?? null;
  const administration = overview?.administration ?? null;

  return (
    <AdminFrame access={access} current="overview" title="Overview">
      <AdminCard id="overview-you" title="Your access">
        <p className="text-sm">
          {access.roles.map(roleLabel).join(", ")}
          {access.owner ? ", and the Owner" : ""}.
        </p>
        {access.owner && access.ownerAuthority && ownerAuthorityBlocked(access.ownerAuthority) ? (
          <p className="mt-2 text-sm text-muted-foreground">{refusalMessage(access.ownerAuthority)} Your account stays protected.</p>
        ) : null}
        <p className="mt-2 flex items-center gap-2 text-sm text-muted-foreground">
          <KeyRound aria-hidden="true" className="size-4 shrink-0" />
          Signed in with your authenticator.{" "}
          <Link href="/settings/security" className={linkClass}>
            Security settings
          </Link>
        </p>
      </AdminCard>
      {access.transferOffered ? (
        <AdminCard id="overview-transfer" title="Ownership offered to you">
          <p className="text-sm">
            @{access.transferOffered.from_handle ?? "the Owner"} has offered you ownership.{" "}
            <Link href="/admin/ownership" className={linkClass}>
              Review the offer
            </Link>
          </p>
        </AdminCard>
      ) : null}
      {!overview ? (
        <AdminCard id="overview-counts" title="Counts">
          <p className="text-sm text-muted-foreground">The counts can&apos;t be loaded right now. Try again later.</p>
        </AdminCard>
      ) : null}
      {catalog ? (
        <AdminCard id="overview-catalog" title="Catalog">
          <Counts
            label="Review queue"
            rows={[
              // The same words as the queue's filters, which these link to.
              { label: "Not started", value: count(catalog.submissions_open, cap), href: "/admin/catalog?status=open" },
              { label: "In review", value: count(catalog.submissions_in_review, cap), href: "/admin/catalog?status=in_review" },
              { label: "Changes requested", value: count(catalog.submissions_changes_requested, cap), href: "/admin/catalog?status=changes_requested" },
            ]}
          />
          <Note>{catalog.oldest_waiting_at ? `The oldest submission waiting arrived on ${formatDay(catalog.oldest_waiting_at)}.` : "No submission is waiting."}</Note>
          <div className="mt-4">
            <Counts
              label="Catalog records"
              rows={[
                { label: "Unpublished games", value: count(catalog.games_unpublished, cap) },
                { label: "Unpublished releases", value: count(catalog.releases_unpublished, cap) },
                { label: "Import items waiting for reclassification", value: count(catalog.reclassifications_open, cap), href: "/admin/catalog/reclassifications" },
                { label: "Merges in the last 30 days", value: count(catalog.merges_30_days, cap), href: "/admin/catalog/merges" },
              ]}
            />
          </div>
        </AdminCard>
      ) : null}
      {accounts ? (
        <AdminCard id="overview-accounts" title="Accounts">
          <Counts label="Accounts" rows={[{ label: "Suspended accounts", value: count(accounts.suspended, cap) }]} />
          <Note>
            <Link href="/admin/accounts" className={linkClass}>
              Find an account by handle
            </Link>{" "}
            to suspend or reinstate it.
          </Note>
        </AdminCard>
      ) : null}
      {administration ? (
        <AdminCard id="overview-administration" title="Administration">
          <Counts
            label="Administration"
            rows={[
              { label: "Active exclusions", value: count(administration.exclusions_active, cap), href: "/admin/catalog/exclusions" },
              { label: "Administrators", value: count(administration.staff_admins, cap), href: "/admin/staff" },
              { label: "Moderators", value: count(administration.staff_moderators, cap), href: "/admin/staff" },
              { label: "Catalog editors", value: count(administration.staff_catalog_editors, cap), href: "/admin/staff" },
              { label: "Refused staff actions in the last 7 days", value: count(administration.refusals_7_days, cap), href: "/admin/audit" },
            ]}
          />
        </AdminCard>
      ) : null}
    </AdminFrame>
  );
}

export default function AdminOverviewPage() {
  return (
    <AdminShell>
      <OverviewView />
    </AdminShell>
  );
}
