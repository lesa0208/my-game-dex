import { Compass, Search } from "lucide-react";
import type { Metadata } from "next";
import { Suspense } from "react";

import { PageLayout } from "@/components/layout/page-layout";
import { SearchForm } from "@/components/layout/search-form";
import { EmptyState } from "@/components/shared/empty-state";

export const metadata: Metadata = {
  title: "Explore",
};

function ExploreComingSoon() {
  return (
    <EmptyState icon={Compass} title="Explore isn't available yet">
      Browsing games, releases and collectors arrives with the game catalog.
    </EmptyState>
  );
}

async function ExploreResults({
  searchParams,
}: {
  searchParams: PageProps<"/explore">["searchParams"];
}) {
  const { q } = await searchParams;
  const query = typeof q === "string" ? q.trim() : "";

  if (!query) return <ExploreComingSoon />;

  return (
    <EmptyState icon={Search} title="Search isn't available yet">
      We can&apos;t search for &ldquo;{query}&rdquo; until the game catalog is
      connected.
    </EmptyState>
  );
}

export default function ExplorePage({ searchParams }: PageProps<"/explore">) {
  return (
    <PageLayout>
      <div className="p-4 md:p-0">
        <h1 className="mb-4 text-xl font-semibold tracking-tight">Explore</h1>
        <SearchForm className="mb-4 md:hidden" />
        <Suspense fallback={<ExploreComingSoon />}>
          <ExploreResults searchParams={searchParams} />
        </Suspense>
      </div>
    </PageLayout>
  );
}
