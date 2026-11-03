"use client";

import { Bookmark, Heart, MessageCircle, Share2 } from "lucide-react";
import { useEffect, useId, useState, type ComponentProps } from "react";

import { Button } from "@/components/ui/button";
import { usePostInteraction } from "@/features/feed/use-post-interaction";
import { formatExactCount } from "@/lib/format";
import { cn } from "@/lib/utils";

const STATUS_TIMEOUT_MS = 3000;

function ActionButton({ className, ...props }: ComponentProps<typeof Button>) {
  return (
    <Button
      variant="ghost"
      className={cn(
        "h-10 min-w-10 gap-2 px-2.5 font-normal text-muted-foreground tabular-nums [&_svg]:size-[1.125rem]",
        className,
      )}
      {...props}
    />
  );
}

type PostActionsProps = {
  postId: string;
  likeCount: number;
  commentCount: number;
  viewerHasLiked: boolean;
  viewerHasBookmarked: boolean;
};

/**
 * Likes and bookmarks are held in browser memory only, and comments report that
 * they aren't available. No interaction here reaches a backend.
 */
export function PostActions({
  postId,
  likeCount,
  commentCount,
  viewerHasLiked,
  viewerHasBookmarked,
}: PostActionsProps) {
  const { liked, bookmarked, toggleLike, toggleBookmark } = usePostInteraction(
    postId,
    { liked: viewerHasLiked, bookmarked: viewerHasBookmarked },
  );
  const [isCommentNoteOpen, setIsCommentNoteOpen] = useState(false);
  const [shareStatus, setShareStatus] = useState("");
  const commentNoteId = useId();

  useEffect(() => {
    if (!shareStatus) return;
    const timeout = setTimeout(() => setShareStatus(""), STATUS_TIMEOUT_MS);
    return () => clearTimeout(timeout);
  }, [shareStatus]);

  const displayedLikes =
    likeCount + (liked === viewerHasLiked ? 0 : liked ? 1 : -1);

  async function sharePost() {
    const url = `${window.location.origin}/home#post-${postId}`;
    try {
      if (typeof navigator.share === "function") {
        await navigator.share({ url });
        return;
      }
      await navigator.clipboard.writeText(url);
      setShareStatus("Link copied");
    } catch (error) {
      const wasDismissed =
        error instanceof DOMException && error.name === "AbortError";
      if (!wasDismissed) setShareStatus("Couldn't copy the link");
    }
  }

  return (
    <div className="mt-2">
      <div className="flex flex-wrap items-center justify-between">
        <div className="flex items-center gap-1">
          <ActionButton
            aria-pressed={liked}
            aria-label={`Like, ${formatExactCount(displayedLikes)} ${displayedLikes === 1 ? "like" : "likes"}`}
            onClick={toggleLike}
            className={cn(liked && "text-foreground")}
          >
            <Heart
              aria-hidden="true"
              className={cn(liked && "fill-primary text-primary")}
            />
            {formatExactCount(displayedLikes)}
          </ActionButton>
          <ActionButton
            aria-expanded={isCommentNoteOpen}
            aria-controls={commentNoteId}
            aria-label={`Comments, ${formatExactCount(commentCount)}`}
            onClick={() => setIsCommentNoteOpen((isOpen) => !isOpen)}
          >
            <MessageCircle aria-hidden="true" />
            {formatExactCount(commentCount)}
          </ActionButton>
        </div>

        <div className="ml-auto flex items-center gap-1">
          <p role="status" className="px-1 text-xs text-muted-foreground">
            {shareStatus}
          </p>
          <ActionButton
            aria-pressed={bookmarked}
            aria-label="Bookmark"
            onClick={toggleBookmark}
            className={cn(bookmarked && "text-foreground")}
          >
            <Bookmark
              aria-hidden="true"
              className={cn(bookmarked && "fill-highlight text-highlight")}
            />
          </ActionButton>
          <ActionButton aria-label="Share" onClick={sharePost}>
            <Share2 aria-hidden="true" />
          </ActionButton>
        </div>
      </div>

      <p
        id={commentNoteId}
        hidden={!isCommentNoteOpen}
        className="mt-2 rounded-md bg-secondary px-3 py-2.5 text-sm text-muted-foreground"
      >
        Comments aren&apos;t available yet. They arrive with the social backend.
      </p>
    </div>
  );
}
