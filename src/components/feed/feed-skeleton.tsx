import { Skeleton } from "@/components/ui/skeleton";

function PostSkeleton() {
  return (
    <div className="border-b bg-card p-4 md:rounded-lg md:border md:p-5">
      <div className="flex items-center gap-3">
        <Skeleton className="size-10 rounded-full" />
        <div className="flex-1 space-y-2">
          <Skeleton className="h-3.5 w-32" />
          <Skeleton className="h-3.5 w-48 max-w-full" />
        </div>
      </div>
      <Skeleton className="mt-4 h-3.5 w-full" />
      <Skeleton className="mt-2 h-3.5 w-3/4" />
      <Skeleton className="mt-4 aspect-8/5 w-full" />
    </div>
  );
}

export function FeedSkeleton() {
  return (
    <div role="status" aria-label="Loading posts" className="flex flex-col md:mt-4 md:gap-4">
      <PostSkeleton />
      <PostSkeleton />
    </div>
  );
}
