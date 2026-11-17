import type { Metadata } from "next";
import Link from "next/link";

import { AdminCard, AdminFrame, AdminShell, linkClass } from "@/components/admin/admin-frame";
import { REFERENCE_PAGES, ReferenceUnavailable, SubNav } from "@/components/admin/data-table";
import { requireAdminSection } from "@/features/admin/queries";
import { platformFamilies } from "@/features/reference/form";
import { getReferenceData } from "@/features/reference/queries";

export const metadata: Metadata = {
  title: "Reference data",
};

async function ReferenceView() {
  // Catalog editors and administrators (D5); staff signed in without their authenticator verify first.
  const { access } = await requireAdminSection("/admin/reference", "editor");
  const data = await getReferenceData();

  return (
    <AdminFrame access={access} current="reference" title="Reference data">
      <SubNav label="Reference data" items={REFERENCE_PAGES} current="/admin/reference" />
      <p className="text-sm text-muted-foreground">
        The fixed lists every catalog record uses. They&apos;re managed by database migrations and are read-only here: a change is made in a migration, reviewed
        like code.
      </p>
      {!data ? (
        <ReferenceUnavailable />
      ) : (
        <div className="grid items-start gap-4 sm:grid-cols-2">
          <AdminCard id="reference-platforms" title="Platforms">
            <p className="text-sm">
              {data.platforms.length} platforms in {platformFamilies(data.platforms).length} families, with {data.names.length} regional names.
            </p>
            <Link href="/admin/reference/platforms" className={`${linkClass} mt-2 inline-block text-sm`}>
              Browse platforms
            </Link>
          </AdminCard>
          <AdminCard id="reference-formats" title="Media formats">
            <p className="text-sm">
              {data.formats.length} formats, {data.platformFormats.length} platform pairings.
            </p>
            <Link href="/admin/reference/formats" className={`${linkClass} mt-2 inline-block text-sm`}>
              Browse media formats
            </Link>
          </AdminCard>
          <AdminCard id="reference-regions" title="Regions and markets">
            <p className="text-sm">
              {data.regions.length} region codes and {data.markets.length} markets.
            </p>
            <Link href="/admin/reference/regions" className={`${linkClass} mt-2 inline-block text-sm`}>
              Browse regions and markets
            </Link>
          </AdminCard>
          <AdminCard id="reference-requirements" title="Hardware requirements">
            <p className="text-sm">{data.requirements.length} revisions, add-ons and compatibility modes a release can need.</p>
            <Link href="/admin/reference/requirements" className={`${linkClass} mt-2 inline-block text-sm`}>
              Browse hardware requirements
            </Link>
          </AdminCard>
        </div>
      )}
    </AdminFrame>
  );
}

export default function ReferencePage() {
  return (
    <AdminShell>
      <ReferenceView />
    </AdminShell>
  );
}
