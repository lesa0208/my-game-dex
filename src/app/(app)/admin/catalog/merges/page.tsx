import { History, PlugZap } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { AdminFrame, AdminShell } from "@/components/admin/admin-frame";
import { EmptyState } from "@/components/shared/empty-state";
import { Button } from "@/components/ui/button";
import { requireAdminSection } from "@/features/admin/queries";
import { formatDay } from "@/features/collection/details";
import { UUID } from "@/features/collection/uuid";
import { releaseLabelLine } from "@/features/exclusion/form";
import { getMerges } from "@/features/merge/queries";

export const metadata: Metadata = {
  title: "Merges",
};

async function MergesView({ searchParams }: { searchParams: PageProps<"/admin/catalog/merges">["searchParams"] }) {
  const search = await searchParams;
  const rawAfter = Array.isArray(search.after) ? search.after[0] : search.after;
  const after = rawAfter && UUID.test(rawAfter) ? rawAfter : null;
  // Catalog editors only (D8); staff signed in without their authenticator verify first.
  const { access } = await requireAdminSection("/admin/catalog/merges", "editor");

  const outcome = await getMerges(after);
  // Anyone but a catalog editor gets the same page as for an address that doesn't exist.
  if (!outcome.ok && outcome.reason === "refused") notFound();

  return (
    <AdminFrame access={access} current="catalog" title="Merges">
      <p className="text-sm text-muted-foreground">Duplicate releases merged into the record kept, newest first. Merges are permanent.</p>
      {!outcome.ok ? (
        <EmptyState icon={PlugZap} title="Merges aren't available">
          They can&apos;t be loaded right now. Try again later.
        </EmptyState>
      ) : !outcome.data.items.length ? (
        <EmptyState icon={History} title="Nothing here">
          No releases have been merged.
        </EmptyState>
      ) : (
        <section aria-labelledby="merges-list">
          <h2 id="merges-list" className="sr-only">
            Merges, newest first
          </h2>
          <ol className="flex flex-col gap-2">
            {outcome.data.items.map((item) => (
              <li key={item.id}>
                <Link
                  href={`/admin/catalog/merges/${item.id}`}
                  className="flex flex-col gap-1 rounded-lg border bg-card p-3 outline-none transition-colors hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring"
                >
                  <span className="font-medium text-pretty">{item.source.game.title}</span>
                  <span className="text-sm text-muted-foreground">
                    {releaseLabelLine(item.source)} → {item.target.game.title === item.source.game.title ? "" : `${item.target.game.title}: `}
                    {releaseLabelLine(item.target)}
                  </span>
                  <span className="text-xs text-muted-foreground">
                    Merged {formatDay(item.merged_at)} · {item.copies_moved === 1 ? "1 copy" : `${item.copies_moved.toLocaleString("en")} copies`} moved
                  </span>
                </Link>
              </li>
            ))}
          </ol>
          {after || outcome.data.next_after ? (
            <nav aria-label="Pages" className="mt-4 flex flex-wrap items-center justify-between gap-2">
              {after ? (
                <Button asChild variant="ghost" size="control">
                  <Link href="/admin/catalog/merges">First page</Link>
                </Button>
              ) : (
                <span />
              )}
              {outcome.data.next_after ? (
                <Button asChild variant="secondary" size="control">
                  <Link href={`/admin/catalog/merges?after=${outcome.data.next_after}`}>Next page</Link>
                </Button>
              ) : null}
            </nav>
          ) : null}
        </section>
      )}
    </AdminFrame>
  );
}

export default function MergesPage({ searchParams }: PageProps<"/admin/catalog/merges">) {
  return (
    <AdminShell>
      <MergesView searchParams={searchParams} />
    </AdminShell>
  );
}
