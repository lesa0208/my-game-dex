import type { Metadata } from "next";
import Link from "next/link";

import { AdminFrame, AdminShell, linkClass } from "@/components/admin/admin-frame";
import { Cell, DataTable, REFERENCE_PAGES, ReferenceUnavailable, SubNav } from "@/components/admin/data-table";
import { requireAdminSection } from "@/features/admin/queries";
import { mediaCategoryLabel } from "@/features/reference/form";
import { getReferenceData } from "@/features/reference/queries";

export const metadata: Metadata = {
  title: "Media formats",
};

async function FormatsView() {
  const { access } = await requireAdminSection("/admin/reference/formats", "editor");
  const data = await getReferenceData();
  const platformsOf = (code: string) =>
    (data?.platformFormats ?? [])
      .filter((f) => f.media_format_code === code)
      .map((f) => data?.platforms.find((p) => p.id === f.platform_id))
      .filter((p): p is NonNullable<typeof p> => Boolean(p))
      .sort((a, b) => a.name.localeCompare(b.name));

  return (
    <AdminFrame access={access} current="reference" title="Media formats">
      <SubNav label="Reference data" items={REFERENCE_PAGES} current="/admin/reference/formats" />
      {!data ? (
        <ReferenceUnavailable />
      ) : (
        <>
          <p className="text-sm text-muted-foreground">The physical media a release can come on. A release&apos;s format must be one paired with its platform.</p>
          <DataTable id="formats-table" caption="Media formats, in their catalog order" head={["Format", "Code", "Category", "Platforms"]}>
            {data.formats.map((f) => {
              const platforms = platformsOf(f.code);
              return (
                <tr key={f.code}>
                  <Cell header>
                    {f.name}
                    {f.description ? <span className="block text-xs font-normal text-muted-foreground">{f.description}</span> : null}
                  </Cell>
                  <Cell>
                    <code className="font-mono text-xs">{f.code}</code>
                  </Cell>
                  <Cell>{mediaCategoryLabel(f.category)}</Cell>
                  <Cell>
                    {platforms.length ? (
                      <span className="flex flex-wrap gap-x-3 gap-y-1">
                        {platforms.map((p) => (
                          <Link key={p.id} href={`/admin/reference/platforms/${p.slug}`} className={linkClass}>
                            {p.short_name ?? p.name}
                          </Link>
                        ))}
                      </span>
                    ) : (
                      <span className="text-muted-foreground">None yet</span>
                    )}
                  </Cell>
                </tr>
              );
            })}
          </DataTable>
        </>
      )}
    </AdminFrame>
  );
}

export default function FormatsPage() {
  return (
    <AdminShell>
      <FormatsView />
    </AdminShell>
  );
}
