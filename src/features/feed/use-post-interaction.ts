"use client";

import { useCallback, useSyncExternalStore } from "react";

type InteractionState = {
  liked: boolean;
  bookmarked: boolean;
};

/**
 * Browser-memory only: nothing is sent anywhere and it clears on reload. It is
 * shared so a like survives switching feed filters. Replace it with server
 * actions when the backend exists.
 */
const interactions = new Map<string, InteractionState>();
const listeners = new Set<() => void>();

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function usePostInteraction(postId: string, initial: InteractionState) {
  const stored = useSyncExternalStore(
    subscribe,
    () => interactions.get(postId),
    () => undefined,
  );
  const liked = stored?.liked ?? initial.liked;
  const bookmarked = stored?.bookmarked ?? initial.bookmarked;

  const update = useCallback(
    (next: InteractionState) => {
      interactions.set(postId, next);
      listeners.forEach((listener) => listener());
    },
    [postId],
  );

  return {
    liked,
    bookmarked,
    toggleLike: () => update({ liked: !liked, bookmarked }),
    toggleBookmark: () => update({ liked, bookmarked: !bookmarked }),
  };
}
