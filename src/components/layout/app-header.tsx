import { Bell, Mail, Search, type LucideIcon } from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";

import { LogoMark, LogoWordmark } from "@/components/layout/logo";
import { SearchForm } from "@/components/layout/search-form";
import { Button } from "@/components/ui/button";
import { siteConfig } from "@/config/site";
import { cn } from "@/lib/utils";

export function HeaderIconLink({
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
      className={cn("size-10 shrink-0 text-muted-foreground", className)}
    >
      <Link href={href} aria-label={label}>
        <Icon aria-hidden="true" className="size-5" />
      </Link>
    </Button>
  );
}

/**
 * Messages and notifications, for a signed-in account only: a visitor has neither, and
 * on a phone they crowded the header until it overlapped the logo (M17a).
 */
export function AccountHeaderLinks() {
  return (
    <>
      <HeaderIconLink href="/messages" label="Messages" icon={Mail} className="md:hidden" />
      <HeaderIconLink href="/notifications" label="Notifications" icon={Bell} />
    </>
  );
}

/**
 * `account` is the account area (messages, notifications and the account menu, or sign
 * in), rendered separately because it reads the session. The logo never shrinks; the
 * account area fits beside it from 320px up.
 */
export function AppHeader({ account }: { account: ReactNode }) {
  return (
    <header className="sticky top-0 z-30 flex h-14 items-center gap-2 border-b bg-background/90 px-3 backdrop-blur sm:gap-3 sm:px-4 md:h-16 md:px-6">
      <Link
        href="/home"
        aria-label={`${siteConfig.name} home`}
        className="flex h-10 shrink-0 items-center gap-2 rounded-lg outline-none focus-visible:ring-3 focus-visible:ring-ring md:hidden"
      >
        <LogoMark className="size-6" />
        <LogoWordmark className="text-xs max-[379px]:hidden" />
      </Link>

      <SearchForm className="hidden max-w-xl flex-1 md:block" />

      <div className="ml-auto flex min-w-0 items-center gap-0.5">
        <HeaderIconLink href="/explore" label="Search" icon={Search} className="md:hidden" />
        {account}
      </div>
    </header>
  );
}
