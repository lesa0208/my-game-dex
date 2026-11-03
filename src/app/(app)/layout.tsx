import { AppHeader } from "@/components/layout/app-header";
import { AppSidebar } from "@/components/layout/app-sidebar";
import { MobileNav } from "@/components/layout/mobile-nav";
import { getCurrentViewer } from "@/features/account/queries";

export default function AppLayout({ children }: { children: React.ReactNode }) {
  const viewer = getCurrentViewer();

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
        <AppHeader viewer={viewer} />
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
