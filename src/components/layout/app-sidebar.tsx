import Link from "next/link";

import { LogoMark, LogoWordmark } from "@/components/layout/logo";
import { SidebarNav } from "@/components/layout/sidebar-nav";
import { siteConfig } from "@/config/site";

/** Icon rail on tablet (md), full sidebar on desktop (lg and up). */
export function AppSidebar() {
  return (
    <aside className="fixed inset-y-0 left-0 z-40 hidden w-18 flex-col border-r bg-sidebar px-3 md:flex lg:w-60 lg:px-4">
      <Link
        href="/home"
        aria-label={`${siteConfig.name} home`}
        className="flex h-16 shrink-0 items-center justify-center gap-2.5 rounded-lg outline-none focus-visible:ring-3 focus-visible:ring-ring lg:justify-start lg:px-3"
      >
        <LogoMark />
        <LogoWordmark className="hidden lg:inline" />
      </Link>

      <div className="mt-2 min-h-0 flex-1 overflow-y-auto">
        <SidebarNav />
      </div>

      <p className="hidden px-3 py-5 text-xs leading-relaxed text-muted-foreground lg:block">
        {siteConfig.tagline}
      </p>
    </aside>
  );
}
