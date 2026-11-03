"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

import { isActivePath, navigationItems } from "@/config/navigation";
import { cn } from "@/lib/utils";

export function SidebarNav() {
  const pathname = usePathname();

  return (
    <nav aria-label="Main">
      <ul className="flex flex-col gap-1">
        {navigationItems.map(({ href, icon: Icon, label }) => {
          const isActive = isActivePath(pathname, href);
          return (
            <li key={href}>
              <Link
                href={href}
                aria-label={label}
                aria-current={isActive ? "page" : undefined}
                title={label}
                className={cn(
                  "flex h-11 items-center justify-center gap-3 rounded-lg text-sm font-medium transition-colors outline-none focus-visible:ring-3 focus-visible:ring-ring lg:justify-start lg:px-3",
                  isActive
                    ? "bg-sidebar-accent text-foreground"
                    : "text-muted-foreground hover:bg-sidebar-accent/60 hover:text-foreground",
                )}
              >
                <Icon
                  aria-hidden="true"
                  className={cn("size-5 shrink-0", isActive && "text-primary")}
                />
                <span className="hidden lg:inline">{label}</span>
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
