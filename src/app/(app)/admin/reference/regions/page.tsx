import type { Metadata } from "next";
import Link from "next/link";

import { AdminCard, AdminFrame, AdminShell, param } from "@/components/admin/admin-frame";
import { Cell, DataTable, REFERENCE_PAGES, ReferenceUnavailable, SubNav } from "@/components/admin/data-table";
import { RecordSection } from "@/components/admin/records";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { requireAdminSection } from "@/features/admin/queries";
import { matchesQuery, readQuery } from "@/features/reference/form";
import { getReferenceData } from "@/features/reference/queries";
import { adminControl } from "@/components/admin/form-controls";

export const metadata: Metadata = {
  title: "Regions and markets",
};

async function RegionsView({ searchParams }: { searchParams: PageProps<"/admin/reference/regions">["searchParams"] }) {
  const search = await searchParams;
  const { access } = await requireAdminSection("/admin/reference/regions", "editor");
  const data = await getReferenceData();
  const query = readQuery(param(search.q));
  const markets = (data?.markets ?? []).filter((m) => matchesQuery(query, m.name, m.code));

  return (
    <AdminFrame access={access} current="reference" title="Regions and markets">
      <SubNav label="Reference data" items={REFERENCE_PAGES} current="/admin/reference/regions" />
      {!data ? (
        <ReferenceUnavailable />
      ) : (
        <>
          <RecordSection id="region-codes" title="Region codes">
            <p className="mb-3 text-sm text-muted-foreground">How collectors classify a release. Each release has exactly one; the countries it was sold in are its markets.</p>
            <DataTable id="regions-table" caption="Region codes, in their catalog order" head={["Region", "Code", "Meaning"]}>
              {data.regions.map((r) => (
                <tr key={r.code}>
                  <Cell header>{r.label}</Cell>
                  <Cell>
                    <code className="font-mono text-xs">{r.code}</code>
                  </Cell>
                  <Cell className="text-muted-foreground">{r.description ?? "—"}</Cell>
                </tr>
              ))}
            </DataTable>
          </RecordSection>
          <AdminCard id="market-filter" title="Markets">
            <form method="get" action="/admin/reference/regions" className="flex flex-col gap-3 sm:flex-row sm:items-end">
              <div className="flex min-w-0 flex-1 flex-col gap-1.5">
                <label htmlFor="market-q" className="text-sm font-medium">
                  Country or code
                </label>
                <Input id="market-q" name="q" maxLength={60} defaultValue={query ?? ""} autoComplete="off" className={adminControl} />
              </div>
              <div className="flex flex-wrap gap-2">
                <Button type="submit" variant="secondary" size="control">
                  Show
                </Button>
                <Button asChild variant="ghost" size="control">
                  <Link href="/admin/reference/regions">Clear</Link>
                </Button>
              </div>
            </form>
            <p role="status" className="mt-3 text-sm text-muted-foreground">
              {query ? `${markets.length} of ${data.markets.length} markets match.` : `${data.markets.length} markets, by ISO 3166-1 code.`}
            </p>
          </AdminCard>
          {markets.length ? (
            <DataTable id="markets-table" caption="Markets, by name" head={["Market", "Code"]}>
              {markets.map((m) => (
                <tr key={m.code}>
                  <Cell header>{m.name}</Cell>
                  <Cell>
                    <code className="font-mono text-xs">{m.code}</code>
                  </Cell>
                </tr>
              ))}
            </DataTable>
          ) : (
            <p className="text-sm text-muted-foreground">No market matches.</p>
          )}
        </>
      )}
    </AdminFrame>
  );
}

export default function RegionsPage({ searchParams }: PageProps<"/admin/reference/regions">) {
  return (
    <AdminShell>
      <RegionsView searchParams={searchParams} />
    </AdminShell>
  );
}
