import type { CollectionItem, Release } from "@/types/game";
import type { Collector } from "@/types/user";

export type PostImage = {
  url: string;
  alt: string;
};

type PostBase = {
  id: string;
  author: Collector;
  /** ISO 8601 timestamp. */
  createdAt: string;
  body: string;
  likeCount: number;
  commentCount: number;
  viewerHasLiked: boolean;
  viewerHasBookmarked: boolean;
};

export type GeneralPost = PostBase & {
  kind: "general";
  image?: PostImage;
  relatedRelease?: Release;
};

export type PickupPost = PostBase & {
  kind: "pickup";
  item: CollectionItem;
};

export type ShowcasePost = PostBase & {
  kind: "showcase";
  shelfName: string;
  gameCount: number;
  image: PostImage;
  featuredReleases: Release[];
};

export type ReviewPost = PostBase & {
  kind: "review";
  title: string;
  release: Release;
  /** Out of 10, in half-point steps. */
  score: number;
};

export type DiscussionPost = PostBase & {
  kind: "discussion";
  title: string;
  relatedRelease?: Release;
};

export type AchievementPost = PostBase & {
  kind: "achievement";
  title: string;
  description: string;
  relatedRelease?: Release;
};

export type Post =
  | GeneralPost
  | PickupPost
  | ShowcasePost
  | ReviewPost
  | DiscussionPost
  | AchievementPost;

export type PostKind = Post["kind"];

export type PopularPost = {
  id: string;
  title: string;
  author: Collector;
  likeCount: number;
  commentCount: number;
};

export type TrendingGame = {
  release: Release;
  activityLabel: string;
};
