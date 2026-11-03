import { Bell, Mail, Search, type LucideIcon } from "lucide-react";
import Link from "next/link";

import { LogoMark, LogoWordmark } from "@/components/layout/logo";
import { SearchForm } from "@/components/layout/search-form";
import { UserMenu } from "@/components/layout/user-menu";
import { Button } from "@/components/ui/button";
import { siteConfig } from "@/config/site";
import { cn } from "@/lib/utils";
import type { Collector } from "@/types/user";

function HeaderIconLink({
  href,
  label,
  icon: Icon,
  className,
}: {
  href: string;
  label: string;
  icon: LucideIcon;
  className?: string;
}) {
  return (
    <Button
      asChild
      variant="ghost"
      size="icon"
      className={cn("size-10 text-muted-foreground", className)}
    >
      <Link href={href} aria-label={label}>
        <Icon aria-hidden="true" className="size-5" />
      </Link>
    </Button>
  );
}

export function AppHeader({ viewer }: { viewer: Collector | null }) {
  return (
    <header className="sticky top-0 z-30 flex h-14 items-center gap-3 border-b bg-background/90 px-4 backdrop-blur md:h-16 md:px-6">
      <Link
        href="/home"
        aria-label={`${siteConfig.name} home`}
        className="flex h-10 min-w-0 items-center gap-2 rounded-lg outline-none focus-visible:ring-3 focus-visible:ring-ring md:hidden"
      >
        <LogoMark className="size-6" />
        <LogoWordmark className="text-xs max-[359px]:hidden" />
      </Link>

      <SearchForm className="hidden max-w-xl flex-1 md:block" />

      <div className="ml-auto flex items-center gap-0.5">
        <HeaderIconLink
          href="/explore"
          label="Search"
          icon={Search}
          className="md:hidden"
        />
        <HeaderIconLink
          href="/messages"
          label="Messages"
          icon={Mail}
          className="md:hidden"
        />
        <HeaderIconLink href="/notifications" label="Notifications" icon={Bell} />
        <UserMenu viewer={viewer} />
      </div>
    </header>
  );
}
