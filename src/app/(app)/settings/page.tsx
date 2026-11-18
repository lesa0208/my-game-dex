import { ChevronRight, KeyRound, ShieldCheck, UserRound, type LucideIcon } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";

import { AccountPageSkeleton } from "@/components/auth/require-account";
import { SignOutButton } from "@/components/auth/sign-out-button";
import { PageLayout } from "@/components/layout/page-layout";
import { UserAvatar } from "@/components/shared/user-avatar";
import { requireViewerWithHandle } from "@/features/account/queries";

export const metadata: Metadata = {
  title: "Settings",
};

const SECTIONS: { href: string; title: string; description: string; icon: LucideIcon }[] = [
  { href: "/settings/profile", title: "Profile", description: "Display name, bio, photo, handle and collection privacy", icon: UserRound },
  { href: "/settings/account", title: "Account and password", description: "Change your password, sign out on your other devices, or download your data", icon: KeyRound },
  { href: "/settings/security", title: "Security", description: "Two-step verification with an authenticator app", icon: ShieldCheck },
];

/** Settings (M11a-3): who's signed in, and the way to each part of the account. */
async function AccountSettings() {
  const viewer = await requireViewerWithHandle("/settings");

  return (
    <div className="flex flex-col gap-6">
      <section aria-labelledby="account-heading" className="rounded-xl border bg-card p-4 sm:p-5">
        <h2 id="account-heading" className="sr-only">
          Account
        </h2>
        <div className="flex flex-wrap items-center gap-4">
          <UserAvatar collector={viewer} size={48} />
          <p className="min-w-0 flex-1 text-sm text-muted-foreground">
            Signed in as <span className="font-medium break-words text-foreground">{viewer.displayName}</span>{" "}
            <span className="break-all">(@{viewer.handle})</span>
          </p>
          <SignOutButton />
        </div>
        {viewer.accountStatus !== "active" ? (
          <p className="mt-3 text-sm text-destructive">This account isn&apos;t active. You can still view your settings and sign out.</p>
        ) : null}
      </section>

      <nav aria-label="Settings">
        <ul className="flex flex-col divide-y overflow-hidden rounded-xl border bg-card">
          {SECTIONS.map(({ href, title, description, icon: Icon }) => (
            <li key={href}>
              <Link
                href={href}
                className="flex min-h-16 items-center gap-3 px-4 py-3 outline-none transition-colors hover:bg-muted/60 focus-visible:bg-muted/60 focus-visible:ring-3 focus-visible:ring-ring/60 focus-visible:ring-inset sm:px-5"
              >
                <Icon aria-hidden="true" className="size-5 shrink-0 text-muted-foreground" />
                <span className="min-w-0 flex-1">
                  <span className="block text-sm font-medium">{title}</span>
                  <span className="block text-sm text-muted-foreground">{description}</span>
                </span>
                <ChevronRight aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
              </Link>
            </li>
          ))}
        </ul>
      </nav>

      <p className="text-sm text-muted-foreground">Appearance and notification settings arrive in a later update.</p>
    </div>
  );
}

export default function SettingsPage() {
  return (
    <PageLayout>
      <div className="p-4 md:p-0">
        <h1 className="mb-4 text-xl font-semibold tracking-tight">Settings</h1>
        <Suspense fallback={<AccountPageSkeleton />}>
          <AccountSettings />
        </Suspense>
      </div>
    </PageLayout>
  );
}
