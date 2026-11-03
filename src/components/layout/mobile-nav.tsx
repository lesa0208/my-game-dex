"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

import { isActivePath, navigationItems } from "@/config/navigation";
import { cn } from "@/lib/utils";

const mobileItems = navigationItems.filter((item) => item.inMobileNav);

export function MobileNav() {
  const pathname = usePathname();

  return (
    <nav
      aria-label="Main"
      className="fixed inset-x-0 bottom-0 z-40 border-t bg-background/95 pb-[env(safe-area-inset-bottom)] backdrop-blur md:hidden"
    >
      <ul className="grid grid-cols-5">
        {mobileItems.map(({ href, icon: Icon, label, shortLabel }) => {
          const isActive = isActivePath(pathname, href);
          return (
            <li key={href}>
              <Link
                href={href}
                aria-label={label}
                aria-current={isActive ? "page" : undefined}
                className={cn(
                  "flex h-14 flex-col items-center justify-center gap-1 text-[0.6875rem] font-medium transition-colors outline-none focus-visible:ring-3 focus-visible:ring-ring focus-visible:ring-inset",
                  isActive ? "text-foreground" : "text-muted-foreground",
                )}
              >
                <Icon
                  aria-hidden="true"
                  className={cn("size-5", isActive && "text-primary")}
                />
                <span>{shortLabel ?? label}</span>
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
