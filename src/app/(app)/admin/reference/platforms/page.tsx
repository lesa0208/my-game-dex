import type { Metadata } from "next";
import Link from "next/link";

import { AdminCard, AdminFrame, AdminShell, linkClass, param } from "@/components/admin/admin-frame";
import { Cell, DataTable, REFERENCE_PAGES, ReferenceUnavailable, SubNav } from "@/components/admin/data-table";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { requireAdminSection } from "@/features/admin/queries";
import { PLATFORM_KIND_OPTIONS, filterPlatforms, platformFamilies, platformKindLabel, readPlatformKind, readQuery } from "@/features/reference/form";
import { getReferenceData } from "@/features/reference/queries";
import { adminControl, adminSelect } from "@/components/admin/form-controls";

export const metadata: Metadata = {
  title: "Platforms",
};

async function PlatformsView({ searchParams }: { searchParams: PageProps<"/admin/reference/platforms">["searchParams"] }) {
  const search = await searchParams;
  const { access } = await requireAdminSection("/admin/reference/platforms", "editor");
  const data = await getReferenceData();
  const query = readQuery(param(search.q));
  const kind = readPlatformKind(param(search.kind));
  const families = data ? platformFamilies(data.platforms) : [];
  const rawFamily = param(search.family);
  const family = rawFamily && families.includes(rawFamily) ? rawFamily : null;
  const shown = data ? filterPlatforms(data.platforms, { kind, family, query }) : [];
  const byId = new Map((data?.platforms ?? []).map((p) => [p.id, p]));
  const formatCount = (id: string) => data?.platformFormats.filter((f) => f.platform_id === id).length ?? 0;

  return (
    <AdminFrame access={access} current="reference" title="Platforms">
      <SubNav label="Reference data" items={REFERENCE_PAGES} current="/admin/reference/platforms" />
      {!data ? (
        <ReferenceUnavailable />
      ) : (
        <>
          <AdminCard id="platform-filters" title="Filter">
            <form method="get" action="/admin/reference/platforms" className="grid items-start gap-4 sm:grid-cols-3">
              <div className="flex min-w-0 flex-col gap-1.5">
                <label htmlFor="platform-q" className="text-sm font-medium">
                  Name or maker
                </label>
                <Input id="platform-q" name="q" maxLength={60} defaultValue={query ?? ""} autoComplete="off" className={adminControl} />
              </div>
              <div className="flex min-w-0 flex-col gap-1.5">
                <label htmlFor="platform-kind" className="text-sm font-medium">
                  Kind
                </label>
                <select id="platform-kind" name="kind" defaultValue={kind ?? ""} className={adminSelect}>
                  <option value="">Any kind</option>
                  {PLATFORM_KIND_OPTIONS.map((k) => (
                    <option key={k.value} value={k.value}>
                      {k.label}
                    </option>
                  ))}
                </select>
              </div>
              <div className="flex min-w-0 flex-col gap-1.5">
                <label htmlFor="platform-family" className="text-sm font-medium">
                  Family
                </label>
                <select id="platform-family" name="family" defaultValue={family ?? ""} className={adminSelect}>
                  <option value="">Any family</option>
                  {families.map((f) => (
                    <option key={f} value={f}>
                      {f}
                    </option>
                  ))}
                </select>
              </div>
              <div className="flex flex-wrap gap-2 sm:col-span-3">
                <Button type="submit" variant="secondary" size="control">
                  Show
                </Button>
                <Button asChild variant="ghost" size="control">
                  <Link href="/admin/reference/platforms">Clear</Link>
                </Button>
              </div>
            </form>
          </AdminCard>
          <p role="status" className="text-sm text-muted-foreground">
            {shown.length === data.platforms.length ? `All ${shown.length} platforms.` : `${shown.length} of ${data.platforms.length} platforms.`}
          </p>
          {shown.length ? (
            <DataTable id="platforms-table" caption="Platforms, by family and year" head={["Platform", "Family", "Kind", "Maker", "Year", "Formats"]}>
              {shown.map((p) => {
                const base = p.base_platform_id ? byId.get(p.base_platform_id) : null;
                return (
                  <tr key={p.id}>
                    <Cell header>
                      <Link href={`/admin/reference/platforms/${p.slug}`} className={linkClass}>
                        {p.name}
                      </Link>
                      {base ? <span className="block text-xs font-normal text-muted-foreground">Add-on for {base.name}</span> : null}
                    </Cell>
                    <Cell>{p.family ?? "—"}</Cell>
                    <Cell>{platformKindLabel(p.kind)}</Cell>
                    <Cell>{p.manufacturer ?? "—"}</Cell>
                    <Cell>{p.released_year ?? "—"}</Cell>
                    <Cell>{formatCount(p.id)}</Cell>
                  </tr>
                );
              })}
            </DataTable>
          ) : (
            <p className="text-sm text-muted-foreground">No platform matches.</p>
          )}
        </>
      )}
    </AdminFrame>
  );
}

export default function PlatformsPage({ searchParams }: PageProps<"/admin/reference/platforms">) {
  return (
    <AdminShell>
      <PlatformsView searchParams={searchParams} />
    </AdminShell>
  );
}
