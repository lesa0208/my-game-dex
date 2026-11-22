import {
  Bell,
  Compass,
  Heart,
  House,
  Library,
  type LucideIcon,
  Mail,
  Settings,
  UserRound,
  Users,
} from "lucide-react";

export type NavigationItem = {
  label: string;
  /** Shorter label for the mobile bottom navigation. */
  shortLabel?: string;
  href: string;
  icon: LucideIcon;
  /** Shown in the five-slot bottom navigation on mobile. */
  inMobileNav: boolean;
};

export const navigationItems: readonly NavigationItem[] = [
  { label: "Home", href: "/home", icon: House, inMobileNav: true },
  { label: "Explore", href: "/explore", icon: Compass, inMobileNav: true },
  {
    label: "My Collection",
    shortLabel: "Collection",
    href: "/collection",
    icon: Library,
    inMobileNav: true,
  },
  // M12 W2: desktop only; on mobile it is reached from My Collection.
  { label: "Wishlist", href: "/collection/wishlist", icon: Heart, inMobileNav: false },
  { label: "Community", href: "/community", icon: Users, inMobileNav: true },
  {
    label: "Notifications",
    href: "/notifications",
    icon: Bell,
    inMobileNav: false,
  },
  { label: "Messages", href: "/messages", icon: Mail, inMobileNav: false },
  {
    label: "My Profile",
    shortLabel: "Profile",
    href: "/profile",
    icon: UserRound,
    inMobileNav: true,
  },
  { label: "Settings", href: "/settings", icon: Settings, inMobileNav: false },
];

export function isActivePath(pathname: string, href: string) {
  return pathname === href || pathname.startsWith(`${href}/`);
}

/**
 * The one item a path belongs to: the most specific match, so /collection/wishlist is
 * Wishlist, not also My Collection. Among items without a more specific one (the mobile
 * bar has no Wishlist), the parent still matches.
 */
export function activeHref(pathname: string, items: readonly NavigationItem[]): string | null {
  return items.filter((item) => isActivePath(pathname, item.href)).sort((a, b) => b.href.length - a.href.length)[0]?.href ?? null;
}
