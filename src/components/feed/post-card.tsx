import { PostActions } from "@/components/feed/post-actions";
import { PostContent } from "@/components/feed/post-content";
import { PostHeader } from "@/components/feed/post-header";
import type { Post } from "@/types/post";

export function PostCard({
  post,
  now,
  isAboveFold = false,
}: {
  post: Post;
  now: number;
  isAboveFold?: boolean;
}) {
  return (
    <article
      id={`post-${post.id}`}
      className="border-b bg-card px-4 pt-4 pb-2 md:rounded-lg md:border md:px-5 md:pt-5"
    >
      <PostHeader post={post} now={now} />
      <div className="mt-3 flex flex-col items-start gap-3 [&>*]:max-w-full [&>div]:w-full">
        <PostContent post={post} isAboveFold={isAboveFold} />
      </div>
      <PostActions
        postId={post.id}
        likeCount={post.likeCount}
        commentCount={post.commentCount}
        viewerHasLiked={post.viewerHasLiked}
        viewerHasBookmarked={post.viewerHasBookmarked}
      />
    </article>
  );
}
