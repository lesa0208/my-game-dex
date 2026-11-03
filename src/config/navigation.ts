import {
  Bell,
  Compass,
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
