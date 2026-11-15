import { KeyRound } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";

import { AdminCard, AdminFrame, AdminShell, linkClass } from "@/components/admin/admin-frame";
import { ownerAuthorityBlocked, refusalMessage, roleLabel } from "@/features/admin/form";
import { requireAdminSection } from "@/features/admin/queries";
import { getExclusions } from "@/features/exclusion/queries";
import { getSubmissionQueue } from "@/features/review/queries";

export const metadata: Metadata = {
  title: "Admin",
};

function count(n: number, more: boolean, one: string, many: string): string {
  if (more) return `50 or more ${many}`;
  return n === 1 ? `1 ${one}` : `${n.toLocaleString("en")} ${many}`;
}

async function OverviewView() {
  const { access } = await requireAdminSection("/admin", "staff");
  const [queue, exclusions] = await Promise.all([access.editor ? getSubmissionQueue("active", null) : null, access.admin ? getExclusions("active", null) : null]);

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
      {access.editor ? (
        <AdminCard id="overview-catalog" title="Catalog">
          <ul className="flex flex-col gap-1.5 text-sm">
            <li>
              <Link href="/admin/catalog" className={linkClass}>
                Review queue
              </Link>
              : {queue ? count(queue.items.length, Boolean(queue.next_after), "submission waiting", "submissions waiting") : "not available right now"}
            </li>
            <li>
              <Link href="/admin/catalog/merges" className={linkClass}>
                Merges
              </Link>
            </li>
            {access.admin ? (
              <li>
                <Link href="/admin/catalog/exclusions" className={linkClass}>
                  Exclusions
                </Link>
                : {exclusions?.ok ? count(exclusions.data.items.length, Boolean(exclusions.data.next), "active exclusion", "active exclusions") : "not available right now"}
              </li>
            ) : null}
          </ul>
        </AdminCard>
      ) : null}
      {access.moderator ? (
        <AdminCard id="overview-accounts" title="Accounts">
          <p className="text-sm">
            <Link href="/admin/accounts" className={linkClass}>
              Find an account by handle
            </Link>{" "}
            to suspend or reinstate it.
          </p>
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
