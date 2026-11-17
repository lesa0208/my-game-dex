import { PlugZap } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";

import { AdminCard, AdminFrame, AdminShell, linkClass } from "@/components/admin/admin-frame";
import { StatusPill, when } from "@/components/admin/data-table";
import { Facts } from "@/components/admin/records";
import { EmptyState } from "@/components/shared/empty-state";
import { requireAdminSection } from "@/features/admin/queries";
import { getSystemStatus } from "@/features/imports/queries";

export const metadata: Metadata = {
  title: "System",
};

/** Policies fixed in code and the database. None can be changed here, and there are no feature flags (D7). */
const POLICIES: { label: string; value: string }[] = [
  { label: "Appearance", value: "Dark Mode only (ADR-056)" },
  { label: "Language", value: "English only (M10 decision D1)" },
  { label: "Staff access", value: "An active account with a staff role, signed in with a verified authenticator, checked by the database on every request" },
  {
    label: "Recent verification",
    value:
      "Within the last 10 minutes for verifying, publishing and changing public catalog records, excluding and restoring, published merges, suspending and reinstating accounts, staff roles, and Owner actions",
  },
  { label: "Reference data", value: "Managed by database migrations; read-only in the app (D5)" },
  { label: "Imports", value: "Run by an operator as the restricted importer role, from cleared sources only; never verified or published by an import (D8)" },
  { label: "Settings", value: "No editable settings or feature flags (D7)" },
];

const capped = (n: number, cap: number) => (n >= cap ? `${cap.toLocaleString("en")} or more` : n.toLocaleString("en"));

async function SystemView() {
  // Administrators only (D7).
  const { access } = await requireAdminSection("/admin/system", "admin");
  const status = await getSystemStatus();

  return (
    <AdminFrame access={access} current="system" title="System">
      <p className="text-sm text-muted-foreground">
        The installation&apos;s state and fixed policies, read-only. No setting, address, key or credential is shown, and nothing here can be changed.
      </p>
      {"error" in status ? (
        <EmptyState icon={PlugZap} title="The system state isn't available">
          It can&apos;t be loaded right now. Try again later.
        </EmptyState>
      ) : (
        <>
          <p className="text-xs text-muted-foreground">Checked {when(status.checked_at)}.</p>
          <div className="grid items-start gap-4 sm:grid-cols-2">
            <AdminCard id="system-database" title="Database">
              <Facts
                rows={[
                  { label: "Migrations applied", value: status.migrations ? status.migrations.applied : "Not recorded" },
                  { label: "Latest migration", value: status.migrations?.latest ? <code className="font-mono text-xs">{status.migrations.latest}</code> : null },
                ]}
              />
            </AdminCard>
            <AdminCard id="system-importer" title="Catalog importer">
              <p className="mb-3">
                {status.importer.login_enabled ? (
                  <StatusPill tone="warning">Login enabled: disable it when no import is running</StatusPill>
                ) : (
                  <StatusPill tone="good">Login disabled</StatusPill>
                )}
              </p>
              <Facts
                rows={[
                  { label: "Runs in progress", value: capped(status.importer.runs_running, status.cap) },
                  { label: "Stopped with an expired lease", value: status.importer.leases_expired ? capped(status.importer.leases_expired, status.cap) : null },
                  { label: "Last run", value: when(status.importer.last_run_at) ?? "Never" },
                  { label: "Sources", value: `${status.providers.total}, ${status.providers.cleared} cleared for use` },
                ]}
              />
              <Link href="/admin/imports" className={`${linkClass} mt-3 inline-block text-sm`}>
                Imports
              </Link>
            </AdminCard>
            <AdminCard id="system-catalog" title="Catalog">
              <Facts
                rows={[
                  { label: "Published games", value: capped(status.catalog.games_published, status.cap) },
                  { label: "Published releases", value: capped(status.catalog.releases_published, status.cap) },
                  { label: "Platforms", value: status.reference.platforms },
                  { label: "Media formats", value: status.reference.media_formats },
                  { label: "Region codes", value: status.reference.region_codes },
                  { label: "Markets", value: status.reference.markets },
                  { label: "Hardware requirements", value: status.reference.hardware_requirements },
                ]}
              />
              <Link href="/admin/reference" className={`${linkClass} mt-3 inline-block text-sm`}>
                Reference data
              </Link>
            </AdminCard>
          </div>
        </>
      )}
      <AdminCard id="system-policies" title="Fixed policies">
        <Facts label="Fixed policies" rows={POLICIES} />
      </AdminCard>
    </AdminFrame>
  );
}

export default function SystemPage() {
  return (
    <AdminShell>
      <SystemView />
    </AdminShell>
  );
}
