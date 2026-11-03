import { Trophy } from "lucide-react";
import Image from "next/image";

import { GameCover } from "@/components/games/game-cover";
import { formatReleaseMeta, ReleaseTag } from "@/components/games/release-tag";
import type { ItemCompleteness } from "@/types/game";
import type {
  AchievementPost,
  DiscussionPost,
  GeneralPost,
  PickupPost,
  Post,
  PostImage,
  ReviewPost,
  ShowcasePost,
} from "@/types/post";

const completenessLabels: Record<ItemCompleteness, string> = {
  loose: "Loose",
  complete: "Complete in box",
  sealed: "Sealed",
};

function PostText({ children }: { children: string }) {
  return <p className="text-[0.9375rem] leading-relaxed text-pretty">{children}</p>;
}

function PostPhoto({
  image,
  isAboveFold,
}: {
  image: PostImage;
  isAboveFold: boolean;
}) {
  return (
    <div className="relative aspect-8/5 overflow-hidden rounded-md bg-secondary">
      <Image
        src={image.url}
        alt={image.alt}
        fill
        sizes="(min-width: 768px) 600px, 100vw"
        loading={isAboveFold ? "eager" : "lazy"}
        className="object-cover"
      />
    </div>
  );
}

type ContentProps<T> = { post: T; isAboveFold: boolean };

function GeneralContent({ post, isAboveFold }: ContentProps<GeneralPost>) {
  return (
    <>
      <PostText>{post.body}</PostText>
      {post.image ? <PostPhoto image={post.image} isAboveFold={isAboveFold} /> : null}
      {post.relatedRelease ? <ReleaseTag release={post.relatedRelease} /> : null}
    </>
  );
}

function PickupContent({ post, isAboveFold }: ContentProps<PickupPost>) {
  const { release, completeness } = post.item;
  return (
    <>
      <PostText>{post.body}</PostText>
      <div className="flex items-center gap-4 rounded-md bg-secondary p-4 sm:gap-6 sm:p-6">
        <GameCover
          release={release}
          sizes="(min-width: 640px) 176px, 128px"
          isAboveFold={isAboveFold}
          className="w-32 sm:w-44"
        />
        <div className="min-w-0">
          <h2 className="font-semibold text-balance sm:text-lg">
            {release.game.title}
          </h2>
          <p className="mt-1 text-sm text-balance text-muted-foreground">
            {formatReleaseMeta(release)}
          </p>
          {release.edition ? (
            <p className="text-sm text-muted-foreground">{release.edition}</p>
          ) : null}
          <p className="mt-3 inline-block rounded-sm border border-highlight/40 px-2 py-0.5 font-mono text-[0.6875rem] tracking-wide text-highlight uppercase">
            {completenessLabels[completeness]}
          </p>
        </div>
      </div>
    </>
  );
}

function ShowcaseContent({ post, isAboveFold }: ContentProps<ShowcasePost>) {
  const remaining = post.gameCount - post.featuredReleases.length;
  return (
    <>
      <PostText>{post.body}</PostText>
      <PostPhoto image={post.image} isAboveFold={isAboveFold} />
      <div className="flex items-end justify-between gap-4">
        <div className="min-w-0">
          <h2 className="font-semibold text-balance">{post.shelfName}</h2>
          <p className="text-sm text-muted-foreground">{post.gameCount} games</p>
        </div>
        <ul className="flex shrink-0 items-center gap-2" aria-label="Featured games">
          {post.featuredReleases.map((release) => (
            <li key={release.id}>
              <GameCover release={release} sizes="56px" className="w-14" />
            </li>
          ))}
          <li className="pl-1 font-mono text-xs text-muted-foreground">
            +{remaining}
          </li>
        </ul>
      </div>
    </>
  );
}

function ReviewContent({ post, isAboveFold }: ContentProps<ReviewPost>) {
  return (
    <>
      <div className="flex gap-4">
        <GameCover
          release={post.release}
          sizes="(min-width: 640px) 112px, 96px"
          isAboveFold={isAboveFold}
          className="w-24 self-start sm:w-28"
        />
        <div className="min-w-0">
          <h2 className="font-semibold text-balance sm:text-lg">{post.title}</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            {post.release.game.title}
          </p>
          <p className="text-sm text-muted-foreground">
            {formatReleaseMeta(post.release)}
          </p>
          <p className="mt-3 flex items-center gap-3">
            <span className="sr-only">Score: {post.score} out of 10</span>
            <span aria-hidden="true" className="font-mono text-xl font-bold">
              {post.score.toFixed(1)}
            </span>
            <span
              aria-hidden="true"
              className="h-1.5 w-24 overflow-hidden rounded-full bg-secondary"
            >
              <span
                className="block h-full rounded-full bg-primary"
                style={{ width: `${post.score * 10}%` }}
              />
            </span>
          </p>
        </div>
      </div>
      <PostText>{post.body}</PostText>
    </>
  );
}

function DiscussionContent({ post }: { post: DiscussionPost }) {
  return (
    <>
      <h2 className="text-lg font-semibold tracking-tight text-balance">
        {post.title}
      </h2>
      <PostText>{post.body}</PostText>
      {post.relatedRelease ? <ReleaseTag release={post.relatedRelease} /> : null}
    </>
  );
}

function AchievementContent({ post }: { post: AchievementPost }) {
  return (
    <>
      <PostText>{post.body}</PostText>
      <div className="flex items-center gap-4 rounded-md border border-primary/30 bg-secondary p-4">
        <span className="flex size-14 shrink-0 items-center justify-center rounded-sm bg-primary/15 outline-2 outline-offset-2 outline-primary/50 outline-dashed">
          <Trophy aria-hidden="true" className="size-7 text-primary" />
        </span>
        <div className="min-w-0">
          <h2 className="font-semibold">{post.title}</h2>
          <p className="text-sm text-muted-foreground">{post.description}</p>
        </div>
      </div>
      {post.relatedRelease ? <ReleaseTag release={post.relatedRelease} /> : null}
    </>
  );
}

export function PostContent({ post, isAboveFold }: ContentProps<Post>) {
  switch (post.kind) {
    case "general":
      return <GeneralContent post={post} isAboveFold={isAboveFold} />;
    case "pickup":
      return <PickupContent post={post} isAboveFold={isAboveFold} />;
    case "showcase":
      return <ShowcaseContent post={post} isAboveFold={isAboveFold} />;
    case "review":
      return <ReviewContent post={post} isAboveFold={isAboveFold} />;
    case "discussion":
      return <DiscussionContent post={post} />;
    case "achievement":
      return <AchievementContent post={post} />;
  }
}
