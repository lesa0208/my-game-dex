import "server-only";

import { connection } from "next/server";

import { isSeedDataEnabled } from "@/config/features";
import { followedCollectorIds, suggestedCollectors } from "@/dev/seed/collectors";
import { seedPosts, seedTrendingGames, type SeedPost } from "@/dev/seed/posts";
import type { FeedFilter } from "@/features/feed/filters";
import type { PopularPost, Post, TrendingGame } from "@/types/post";
import type { SuggestedCollector } from "@/types/user";

/**
 * The only path from UI to feed data. It reads seed data for now; when the
 * backend arrives these functions change and the components calling them don't.
 */

const POPULAR_POST_COUNT = 3;

function selectSeedPosts(filter: FeedFilter): SeedPost[] {
  const byNewest = (a: SeedPost, b: SeedPost) => a.ageInMinutes - b.ageInMinutes;

  switch (filter) {
    case "for-you":
      return seedPosts;
    case "following":
      return seedPosts
        .filter((post) => followedCollectorIds.has(post.author.id))
        .sort(byNewest);
    case "latest":
      return [...seedPosts].sort(byNewest);
  }
}

/** Runs at request time: it reads the clock to date the seed posts. */
export async function getFeedPage(
  filter: FeedFilter,
): Promise<{ posts: Post[]; fetchedAt: number }> {
  await connection();
  const fetchedAt = Date.now();
  if (!isSeedDataEnabled) return { posts: [], fetchedAt };

  const posts = selectSeedPosts(filter).map(({ ageInMinutes, ...post }) => ({
    ...post,
    createdAt: new Date(fetchedAt - ageInMinutes * 60_000).toISOString(),
  }));
  return { posts, fetchedAt };
}

function getSeedPostTitle(post: SeedPost) {
  switch (post.kind) {
    case "review":
    case "discussion":
      return post.title;
    case "achievement":
      return `Unlocked ${post.title}`;
    case "showcase":
      return post.shelfName;
    case "pickup":
      return `Picked up ${post.item.release.game.title}`;
    case "general":
      return post.body;
  }
}

export type FeedSidebarData = {
  trendingGames: TrendingGame[];
  suggestedCollectors: SuggestedCollector[];
  popularPosts: PopularPost[];
};

export function getFeedSidebarData(): FeedSidebarData | null {
  if (!isSeedDataEnabled) return null;

  const popularPosts = [...seedPosts]
    .sort((a, b) => b.likeCount - a.likeCount)
    .slice(0, POPULAR_POST_COUNT)
    .map((post) => ({
      id: post.id,
      title: getSeedPostTitle(post),
      author: post.author,
      likeCount: post.likeCount,
      commentCount: post.commentCount,
    }));

  return {
    trendingGames: seedTrendingGames,
    suggestedCollectors,
    popularPosts,
  };
}
