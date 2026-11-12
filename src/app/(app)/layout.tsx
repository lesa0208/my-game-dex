import { Suspense } from "react";

import { AppHeader } from "@/components/layout/app-header";
import { AppSidebar } from "@/components/layout/app-sidebar";
import { MobileNav } from "@/components/layout/mobile-nav";
import { UserMenu, UserMenuPlaceholder } from "@/components/layout/user-menu";
import { getCurrentViewer } from "@/features/account/queries";
import { canReview } from "@/features/review/queries";

/** Reads the session, so it streams in on its own and the rest of the page doesn't wait. */
async function AccountMenu() {
  // If the account can't be read, offering sign-in is safe: it shows nothing private.
  const viewer = await getCurrentViewer().catch(() => null);
  const reviewer = viewer?.isActive ? await canReview().catch(() => false) : false;
  return <UserMenu viewer={viewer} canReview={reviewer} />;
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
