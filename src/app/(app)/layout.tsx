import { Suspense } from "react";

import { AppHeader } from "@/components/layout/app-header";
import { AppSidebar } from "@/components/layout/app-sidebar";
import { MobileNav } from "@/components/layout/mobile-nav";
import { UserMenu, UserMenuPlaceholder } from "@/components/layout/user-menu";
import { getCurrentViewer } from "@/features/account/queries";
import { getAdminAccess } from "@/features/admin/queries";
import { selfRegistrationOpen } from "@/features/auth/registration";

/** Reads the session, so it streams in on its own and the rest of the page doesn't wait. */
async function AccountMenu() {
  // If the account can't be read, offering sign-in is safe: it shows nothing private.
  const viewer = await getCurrentViewer().catch(() => null);
  const access = viewer?.isActive ? await getAdminAccess().catch(() => null) : null;
  return <UserMenu viewer={viewer} isStaff={(access?.roles.length ?? 0) > 0} canSignUp={!viewer && selfRegistrationOpen()} />;
}

export default function AppLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <a
        href="#main-content"
        className="sr-only z-50 rounded-lg bg-primary-solid text-sm font-medium text-primary-solid-foreground focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:px-4 focus:py-2"
      >
        Skip to content
      </a>
      <AppSidebar />
      <div className="flex min-h-dvh flex-col md:pl-18 lg:pl-60">
        {/* M16: only the demo preview's build sets this (scripts/demo-preview.mjs). */}
        {process.env.NEXT_PUBLIC_MGD_DEMO_CATALOG === "1" ? (
          <p role="note" className="border-b border-amber-500/40 bg-amber-500/10 px-4 py-2 text-center text-xs text-foreground">
            <span className="font-medium">Demo catalog.</span> Real games from Wikidata, published for this local demo without editorial review. Not the
            real catalog.
          </p>
        ) : null}
        <AppHeader
          account={
            <Suspense fallback={<UserMenuPlaceholder />}>
              <AccountMenu />
            </Suspense>
          }
        />
        <main
          id="main-content"
          className="flex-1 pb-[calc(3.5rem+env(safe-area-inset-bottom))] md:pb-0"
        >
          {children}
        </main>
      </div>
      <MobileNav />
    </>
  );
}
