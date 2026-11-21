import { Copy, Gamepad2, PackageCheck, Star } from "lucide-react";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Suspense } from "react";

import { ShelfBrowser } from "@/components/shelf/shelf-browser";
import { Breadcrumbs, ShelfPreviewNotice, ShelfSkeleton } from "@/components/shelf/shelf-parts";
import { EmptyShelf, SystemHeader } from "@/components/shelf/system-header";
import { SAMPLE_SORTS, sampleItem } from "@/features/shelf/browse";
import { getPreviewShelf, previewParams } from "@/features/shelf/queries";

export function generateStaticParams() {
  return previewParams().map(({ platform }) => ({ platform }));
}

export async function generateMetadata({ params }: PageProps<"/collection/preview/[platform]">): Promise<Metadata> {
  const { platform } = await params;
  return { title: `${getPreviewShelf(platform)?.system.shortName ?? "System"} (preview)` };
}

const SAMPLE_NOUN = { one: "game", many: "games" };

async function SystemShelf({ params }: PageProps<"/collection/preview/[platform]">) {
  const { platform } = await params;
  const shelf = getPreviewShelf(platform);
  if (!shelf) notFound();
  const { system, games } = shelf;
  const items = games.map((game) => sampleItem(game, system.media, `/collection/preview/${system.slug}/${game.slug}`));

  return (
    <div className="mx-auto w-full max-w-[1320px] px-4 py-4 md:px-6 md:py-6">
      <Breadcrumbs
        items={[
          { label: "My Collection", href: "/collection" },
          { label: "Systems preview", href: "/collection/preview" },
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
          { icon: Gamepad2, value: system.stats.games.toString(), label: "Games" },
          { icon: Copy, value: system.stats.copies.toString(), label: "Copies" },
          { icon: Star, value: system.stats.favorites.toString(), label: "Favorites" },
          { icon: PackageCheck, value: `${system.stats.completeShare}%`, label: "Complete in box" },
        ]}
      />

      <div className="mt-4">
        <ShelfPreviewNotice />
      </div>

      <div className="mt-6">
        {games.length === 0 ? (
          <EmptyShelf name={system.name} shortName={system.shortName} allHref="/collection/preview" />
        ) : (
          <ShelfBrowser items={items} systemLabel={system.shortName} frame={system.media} sorts={SAMPLE_SORTS} favorites noun={SAMPLE_NOUN} />
        )}
      </div>
    </div>
  );
}

/** The visual preview of a system's shelf, on sample data. The real one is /collection/systems/[platform]. */
export default function SystemShelfPreviewPage(props: PageProps<"/collection/preview/[platform]">) {
  return (
    <Suspense fallback={<ShelfSkeleton />}>
      <SystemShelf {...props} />
    </Suspense>
  );
}
