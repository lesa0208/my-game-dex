import {
  LayoutGrid,
  MessagesSquare,
  PackageOpen,
  Star,
  Trophy,
  type LucideIcon,
} from "lucide-react";

import { UserAvatar } from "@/components/shared/user-avatar";
import { formatRelativeTime } from "@/lib/format";
import type { Post, PostKind } from "@/types/post";

const postKindLabels: Record<
  Exclude<PostKind, "general">,
  { label: string; icon: LucideIcon }
> = {
  pickup: { label: "New Pickup", icon: PackageOpen },
  showcase: { label: "Collection Showcase", icon: LayoutGrid },
  review: { label: "Game Review", icon: Star },
  discussion: { label: "Discussion", icon: MessagesSquare },
  achievement: { label: "Achievement", icon: Trophy },
};

function PostKindLabel({ kind }: { kind: PostKind }) {
  if (kind === "general") return null;

  const { label, icon: Icon } = postKindLabels[kind];
  return (
    <p className="mb-3 flex items-center gap-1.5 font-mono text-[0.6875rem] font-medium tracking-widest text-muted-foreground uppercase">
      <Icon aria-hidden="true" className="size-3.5 text-primary" />
      {label}
    </p>
  );
}

export function PostHeader({ post, now }: { post: Post; now: number }) {
  return (
    <header>
      <PostKindLabel kind={post.kind} />
      <div className="flex items-center gap-3">
        <UserAvatar collector={post.author} />
        <div className="min-w-0">
          <p className="truncate text-sm font-medium">{post.author.displayName}</p>
          <p className="flex gap-1.5 text-sm text-muted-foreground">
            <span className="truncate">@{post.author.handle}</span>
            <span aria-hidden="true">·</span>
            <time dateTime={post.createdAt} className="shrink-0">
              {formatRelativeTime(post.createdAt, now)}
            </time>
          </p>
        </div>
      </div>
    </header>
  );
}
