import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { AdminFrame, AdminShell, linkClass } from "@/components/admin/admin-frame";
import { Cell, DataTable, REFERENCE_PAGES, ReferenceUnavailable, SubNav } from "@/components/admin/data-table";
import { Facts, RecordSection } from "@/components/admin/records";
import { requireAdminSection } from "@/features/admin/queries";
import { mediaCategoryLabel, platformKindLabel, requirementKindLabel } from "@/features/reference/form";
import { getReferenceData } from "@/features/reference/queries";

export const metadata: Metadata = {
  title: "Platform",
};

const SLUG = /^[a-z0-9]+(-[a-z0-9]+)*$/;

async function PlatformView({ params }: { params: PageProps<"/admin/reference/platforms/[slug]">["params"] }) {
  const { slug } = await params;
  const valid = SLUG.test(slug) && slug.length <= 80;
  const { access } = await requireAdminSection(valid ? `/admin/reference/platforms/${slug}` : "/admin/reference/platforms", "editor");
  if (!valid) notFound();
  const data = await getReferenceData();
  if (!data) {
    return (
      <AdminFrame access={access} current="reference" title="Platform">
        <SubNav label="Reference data" items={REFERENCE_PAGES} current="/admin/reference/platforms" />
        <ReferenceUnavailable />
      </AdminFrame>
    );
  }
  const p = data.platforms.find((x) => x.slug === slug);
  if (!p) notFound();
  const base = p.base_platform_id ? data.platforms.find((x) => x.id === p.base_platform_id) : null;
  const addOns = data.platforms.filter((x) => x.base_platform_id === p.id);
  const names = data.names.filter((n) => n.platform_id === p.id);
  const regionLabel = (code: string | null) => (code ? (data.regions.find((r) => r.code === code)?.label ?? code) : "Any region");
  const formats = data.platformFormats
    .filter((f) => f.platform_id === p.id)
    .map((f) => data.formats.find((m) => m.code === f.media_format_code))
    .filter((f): f is NonNullable<typeof f> => Boolean(f))
    .sort((a, b) => a.position - b.position);
  const requirements = data.requirements.filter((r) => r.platform_id === p.id);

  return (
    <AdminFrame access={access} current="reference" title={p.name}>
      <SubNav label="Reference data" items={REFERENCE_PAGES} current="/admin/reference/platforms" />
      <RecordSection id="platform-facts" title="Platform">
        <Facts
          rows={[
            { label: "Name", value: p.name },
            { label: "Short name", value: p.short_name },
            { label: "Slug", value: <code className="font-mono text-xs">{p.slug}</code> },
            { label: "Kind", value: platformKindLabel(p.kind) },
            { label: "Family", value: p.family },
            { label: "Maker", value: p.manufacturer },
            { label: "Year", value: p.released_year },
            {
              label: "Add-on for",
              value: base ? (
                <Link href={`/admin/reference/platforms/${base.slug}`} className={linkClass}>
                  {base.name}
                </Link>
              ) : null,
            },
            {
              label: "Add-ons",
              value: addOns.length ? (
                <span className="flex flex-wrap gap-x-3 gap-y-1">
                  {addOns.map((a) => (
                    <Link key={a.id} href={`/admin/reference/platforms/${a.slug}`} className={linkClass}>
                      {a.name}
                    </Link>
                  ))}
                </span>
              ) : null,
            },
            { label: "Notes", value: p.notes },
          ]}
        />
      </RecordSection>
      <RecordSection id="platform-names" title="Regional names">
        {names.length ? (
          <ul className="flex flex-col gap-1 text-sm">
            {names.map((n) => (
              <li key={`${n.name}-${n.region_code}`}>
                {n.name} <span className="text-muted-foreground">· {regionLabel(n.region_code)}</span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-muted-foreground">No other names.</p>
        )}
      </RecordSection>
      <RecordSection id="platform-formats" title="Media formats">
        {formats.length ? (
          <DataTable id="platform-formats-table" caption={`Media formats for ${p.name}`} head={["Format", "Code", "Category"]}>
            {formats.map((f) => (
              <tr key={f.code}>
                <Cell header>{f.name}</Cell>
                <Cell>
                  <code className="font-mono text-xs">{f.code}</code>
                </Cell>
                <Cell>{mediaCategoryLabel(f.category)}</Cell>
              </tr>
            ))}
          </DataTable>
        ) : (
          <p className="text-sm text-muted-foreground">No media format is paired with this platform, so no release can be cataloged on it yet.</p>
        )}
      </RecordSection>
      <RecordSection id="platform-requirements" title="Hardware requirements">
        {requirements.length ? (
          <ul className="flex flex-col gap-2 text-sm">
            {requirements.map((r) => (
              <li key={r.code}>
                <span className="font-medium">{r.label}</span> <span className="text-muted-foreground">· {requirementKindLabel(r.kind)}</span>
                {r.description ? <span className="block text-muted-foreground">{r.description}</span> : null}
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-muted-foreground">None.</p>
        )}
      </RecordSection>
    </AdminFrame>
  );
}

export default function PlatformPage({ params }: PageProps<"/admin/reference/platforms/[slug]">) {
  return (
    <AdminShell>
      <PlatformView params={params} />
    </AdminShell>
  );
}
