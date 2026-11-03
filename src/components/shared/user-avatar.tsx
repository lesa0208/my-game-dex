import Image from "next/image";

import { cn } from "@/lib/utils";
import type { Collector } from "@/types/user";

type UserAvatarProps = {
  collector: Pick<Collector, "displayName" | "avatarUrl">;
  size?: number;
  className?: string;
};

export function UserAvatar({ collector, size = 40, className }: UserAvatarProps) {
  const classes = cn("shrink-0 rounded-full object-cover", className);

  if (collector.avatarUrl) {
    return (
      <Image
        src={collector.avatarUrl}
        alt=""
        width={size}
        height={size}
        className={classes}
      />
    );
  }

  return (
    <span
      aria-hidden="true"
      style={{ width: size, height: size }}
      className={cn(
        classes,
        "flex items-center justify-center bg-secondary text-sm font-medium",
      )}
    >
      {collector.displayName.charAt(0).toUpperCase()}
    </span>
  );
}
