import type { Metadata } from "next";
import Link from "next/link";

import { AdminFrame, AdminShell, linkClass } from "@/components/admin/admin-frame";
import { Cell, DataTable, REFERENCE_PAGES, ReferenceUnavailable, SubNav } from "@/components/admin/data-table";
import { requireAdminSection } from "@/features/admin/queries";
import { requirementKindLabel } from "@/features/reference/form";
import { getReferenceData } from "@/features/reference/queries";

export const metadata: Metadata = {
  title: "Hardware requirements",
};

async function RequirementsView() {
  const { access } = await requireAdminSection("/admin/reference/requirements", "editor");
  const data = await getReferenceData();
  const platform = (id: string) => data?.platforms.find((p) => p.id === id) ?? null;
  const rows = (data?.requirements ?? [])
    .map((r) => ({ ...r, platform: platform(r.platform_id) }))
    .sort((a, b) => (a.platform?.name ?? "").localeCompare(b.platform?.name ?? "") || a.label.localeCompare(b.label));

  return (
    <AdminFrame access={access} current="reference" title="Hardware requirements">
      <SubNav label="Reference data" items={REFERENCE_PAGES} current="/admin/reference/requirements" />
      {!data ? (
        <ReferenceUnavailable />
      ) : (
        <>
          <p className="text-sm text-muted-foreground">Revisions, add-ons and compatibility modes a release can need, each for one platform.</p>
          <DataTable id="requirements-table" caption="Hardware requirements, by platform" head={["Requirement", "Code", "Kind", "Platform"]}>
            {rows.map((r) => (
              <tr key={r.code}>
                <Cell header>
                  {r.label}
                  {r.description ? <span className="block text-xs font-normal text-muted-foreground">{r.description}</span> : null}
                </Cell>
                <Cell>
                  <code className="font-mono text-xs">{r.code}</code>
                </Cell>
                <Cell>{requirementKindLabel(r.kind)}</Cell>
                <Cell>
                  {r.platform ? (
                    <Link href={`/admin/reference/platforms/${r.platform.slug}`} className={linkClass}>
                      {r.platform.name}
                    </Link>
                  ) : (
                    "—"
                  )}
                </Cell>
              </tr>
            ))}
          </DataTable>
        </>
      )}
    </AdminFrame>
  );
}

export default function RequirementsPage() {
  return (
    <AdminShell>
      <RequirementsView />
    </AdminShell>
  );
}
