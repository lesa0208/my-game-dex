import Image from "next/image";

import { cn } from "@/lib/utils";
import type { Collector } from "@/types/user";

type UserAvatarProps = {
  collector: Pick<Collector, "displayName" | "avatarUrl">;
  size?: number;
  className?: string;
  /** Text for the image; decorative (empty) by default, as the name is usually beside it. */
  alt?: string;
};

export function UserAvatar({ collector, size = 40, className, alt = "" }: UserAvatarProps) {
  const classes = cn("shrink-0 rounded-full object-cover", className);

  if (collector.avatarUrl) {
    return (
      <Image
        src={collector.avatarUrl}
        alt={alt}
        width={size}
        height={size}
        className={classes}
        // M11a-3: an uploaded avatar is already a 512px WebP from the public avatars
        // bucket, so it's served as it is rather than through the image optimizer.
        unoptimized={/^https?:\/\//.test(collector.avatarUrl)}
      />
    );
  }

  // The fallback: the name's first letter, at a size that suits the circle.
  const initial = [...collector.displayName.trim()][0]?.toUpperCase() ?? "?";
  return (
    <span
      role={alt ? "img" : undefined}
      aria-label={alt || undefined}
      aria-hidden={alt ? undefined : true}
      style={{ width: size, height: size, fontSize: Math.max(12, Math.round(size * 0.4)) }}
      className={cn(classes, "flex items-center justify-center bg-secondary font-medium text-secondary-foreground select-none")}
    >
      {initial}
    </span>
  );
}
