import { Heart, MessageCircle } from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";

import { GameCover } from "@/components/games/game-cover";
import { UserAvatar } from "@/components/shared/user-avatar";
import { Button } from "@/components/ui/button";
import type { FeedSidebarData } from "@/features/feed/queries";
import { formatCount } from "@/lib/format";

function SidebarSection({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}) {
  return (
    <section className="rounded-lg border bg-card p-4">
      <h2 className="mb-3 font-mono text-[0.6875rem] font-medium tracking-widest text-muted-foreground uppercase">
        {title}
      </h2>
      {children}
    </section>
  );
}

function TrendingGames({ games }: { games: FeedSidebarData["trendingGames"] }) {
  return (
    <SidebarSection title="Trending Games">
      <ol className="flex flex-col gap-3">
        {games.map(({ release, activityLabel }, index) => (
          <li key={release.id} className="flex items-center gap-3">
            <span className="w-3 shrink-0 font-mono text-xs text-muted-foreground">
              {index + 1}
            </span>
            <GameCover release={release} sizes="48px" className="w-12" />
            <div className="min-w-0">
              <p className="truncate text-sm font-medium">{release.game.title}</p>
              <p className="truncate text-xs text-muted-foreground">
                {release.platform.name}
              </p>
              <p className="truncate text-xs text-highlight">{activityLabel}</p>
            </div>
          </li>
        ))}
      </ol>
    </SidebarSection>
  );
}

function SuggestedCollectors({
  collectors,
}: {
  collectors: FeedSidebarData["suggestedCollectors"];
}) {
  return (
    <SidebarSection title="Suggested Collectors">
      <ul className="flex flex-col gap-3">
        {collectors.map((collector) => (
          <li key={collector.id} className="flex items-center gap-3">
            <UserAvatar collector={collector} />
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium">{collector.displayName}</p>
              <p className="text-xs text-pretty text-muted-foreground">
                {collector.focus}
              </p>
              <p className="mt-0.5 font-mono text-[0.6875rem] text-muted-foreground">
                {collector.gamesCataloged} games
              </p>
            </div>
            <Button
              variant="outline"
              size="sm"
              disabled
              title="Following arrives with accounts"
            >
              Follow
            </Button>
          </li>
        ))}
      </ul>
    </SidebarSection>
  );
}

function PopularPosts({ posts }: { posts: FeedSidebarData["popularPosts"] }) {
  return (
    <SidebarSection title="Popular Posts">
      <ul className="-mx-2 flex flex-col">
        {posts.map((post) => (
          <li key={post.id}>
            <Link
              href={`/home#post-${post.id}`}
              className="block rounded-md p-2 transition-colors outline-none hover:bg-accent focus-visible:ring-3 focus-visible:ring-ring"
            >
              <p className="line-clamp-2 text-sm font-medium text-pretty">
                {post.title}
              </p>
              <p className="mt-1 flex items-center gap-3 text-xs text-muted-foreground">
                <span className="min-w-0 truncate">@{post.author.handle}</span>
                <span className="flex shrink-0 items-center gap-1">
                  <Heart aria-hidden="true" className="size-3" />
                  <span className="sr-only">Likes:</span>
                  {formatCount(post.likeCount)}
                </span>
                <span className="flex shrink-0 items-center gap-1">
                  <MessageCircle aria-hidden="true" className="size-3" />
                  <span className="sr-only">Comments:</span>
                  {formatCount(post.commentCount)}
                </span>
              </p>
            </Link>
          </li>
        ))}
      </ul>
    </SidebarSection>
  );
}

export function FeedSidebar({ data }: { data: FeedSidebarData }) {
  return (
    <div className="flex flex-col gap-4">
      <TrendingGames games={data.trendingGames} />
      <SuggestedCollectors collectors={data.suggestedCollectors} />
      <PopularPosts posts={data.popularPosts} />
    </div>
  );
}
