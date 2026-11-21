import { Copy, Gamepad2, Info, PackageCheck, PlugZap } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Suspense } from "react";

import { EmptyState } from "@/components/shared/empty-state";
import { ShelfBrowser } from "@/components/shelf/shelf-browser";
import { Breadcrumbs, ShelfSkeleton } from "@/components/shelf/shelf-parts";
import { EmptyShelf, SystemHeader } from "@/components/shelf/system-header";
import { requireViewerWithHandle } from "@/features/account/queries";
import type { ShelfSort } from "@/features/shelf/browse";
import { getMyShelf, SHELF_LIMIT } from "@/features/shelf/collection";

export const metadata: Metadata = {
  title: "System shelf",
};

/** The orders a real shelf offers: copies have no release year, and no favourites yet. */
const COPY_SORTS: readonly ShelfSort[] = ["title", "added", "acquired", "condition"];
const COPY_NOUN = { one: "copy", many: "copies" };

async function Shelf({ params }: PageProps<"/collection/systems/[platform]">) {
  const { platform } = await params;
  // Signed in first, so nothing is read for a visitor. The slug goes back into `next`
  // only when it's well formed; anything else returns to the Systems page.
  await requireViewerWithHandle(/^[a-z0-9-]{1,64}$/.test(platform) ? `/collection/systems/${platform}` : "/collection/systems");
  const result = await getMyShelf(platform);
  if (result === null) notFound();
  if (!result.ok) {
    return (
      <div className="mt-6">
        <EmptyState icon={PlugZap} title="This shelf isn't available">
          It can&apos;t be loaded right now. Try again later.
        </EmptyState>
      </div>
    );
  }

  const { system, items, truncated, stats } = result.data;
  const completeShare = stats.copies ? Math.round((stats.complete / stats.copies) * 100) : 0;

  return (
    <>
      <Breadcrumbs
        items={[
          { label: "My Collection", href: "/collection" },
          { label: "Systems", href: "/collection/systems" },
          { label: system.shortName },
        ]}
      />
      <SystemHeader
        name={system.name}
        maker={system.maker}
        released={system.released}
        console={system.console}
        accent={system.accent[0]}
        stats={[
          { icon: Copy, value: `${stats.copies.toLocaleString("en")}${truncated ? "+" : ""}`, label: "Copies" },
          { icon: Gamepad2, value: stats.games.toLocaleString("en"), label: "Games" },
          { icon: PackageCheck, value: `${completeShare}%`, label: "Complete or sealed" },
        ]}
      />

      {truncated ? (
        <p className="mt-4 flex gap-2 rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2.5 text-sm">
          <Info aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
          <span>
            This shelf shows your first {SHELF_LIMIT.toLocaleString("en")} {system.shortName} copies by title.{" "}
            <Link href={`/collection?platform=${system.slug}`} className="font-medium text-primary-text underline underline-offset-4">
              See every copy in the list
            </Link>
          </span>
        </p>
      ) : null}

      <div className="mt-6">
        {items.length === 0 ? (
          <EmptyShelf name={system.name} shortName={system.shortName} allHref="/collection/systems" />
        ) : (
          <ShelfBrowser items={items} systemLabel={system.shortName} frame={system.frame} sorts={COPY_SORTS} favorites={false} noun={COPY_NOUN} />
        )}
      </div>
    </>
  );
}

/** One of the signed-in collector's system shelves, with every copy they have on it. */
export default function SystemShelfPage(props: PageProps<"/collection/systems/[platform]">) {
  return (
    <div className="mx-auto w-full max-w-[1320px] px-4 py-4 md:px-6 md:py-6">
      <Suspense fallback={<ShelfSkeleton />}>
        <Shelf {...props} />
      </Suspense>
    </div>
  );
}
