import type { Metadata } from "next";
import { Suspense } from "react";

import { FeedFilters } from "@/components/feed/feed-filters";
import { FeedSidebar } from "@/components/feed/feed-sidebar";
import { FeedSkeleton } from "@/components/feed/feed-skeleton";
import { FeedView } from "@/components/feed/feed-view";
import { PreviewNotice } from "@/components/feed/preview-notice";
import { PageLayout } from "@/components/layout/page-layout";
import { getFeedSidebarData } from "@/features/feed/queries";

export const metadata: Metadata = {
  title: "Home",
};

export default function HomePage({ searchParams }: PageProps<"/home">) {
  const sidebarData = getFeedSidebarData();

  return (
    <PageLayout aside={sidebarData ? <FeedSidebar data={sidebarData} /> : undefined}>
      <h1 className="sr-only">Home feed</h1>
      <PreviewNotice />
      <Suspense
        fallback={
          <>
            <FeedFilters />
            <FeedSkeleton />
          </>
        }
      >
        <FeedView searchParams={searchParams} />
      </Suspense>
    </PageLayout>
  );
}
