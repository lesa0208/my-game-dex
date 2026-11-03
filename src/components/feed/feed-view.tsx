import { Rss, UsersRound } from "lucide-react";

import { FeedFilters } from "@/components/feed/feed-filters";
import { PostCard } from "@/components/feed/post-card";
import { EmptyState } from "@/components/shared/empty-state";
import { parseFeedFilter, type FeedFilter } from "@/features/feed/filters";
import { getFeedPage } from "@/features/feed/queries";

const ABOVE_FOLD_POST_COUNT = 2;

function FeedEmpty({ filter }: { filter: FeedFilter }) {
  if (filter === "following") {
    return (
      <EmptyState icon={UsersRound} title="Nothing from collectors you follow">
        Posts from collectors you follow will appear here.
      </EmptyState>
    );
  }

  return (
    <EmptyState icon={Rss} title="No posts yet">
      New pickups, reviews and shelves from the community will appear here.
    </EmptyState>
  );
}

export async function FeedView({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { feed } = await searchParams;
  const filter = parseFeedFilter(feed);
  const { posts, fetchedAt } = await getFeedPage(filter);

  return (
    <>
      <FeedFilters active={filter} />
      <div className="md:mt-4">
        {posts.length > 0 ? (
          <div className="flex flex-col md:gap-4">
            {posts.map((post, index) => (
              <PostCard
                key={post.id}
                post={post}
                now={fetchedAt}
                isAboveFold={index < ABOVE_FOLD_POST_COUNT}
              />
            ))}
          </div>
        ) : (
          <div className="p-4 md:p-0">
            <FeedEmpty filter={filter} />
          </div>
        )}
      </div>
    </>
  );
}
