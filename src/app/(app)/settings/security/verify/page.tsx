import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";

import { AdminCard, PageMessage, param } from "@/components/admin/admin-frame";
import { AccountPageSkeleton } from "@/components/auth/require-account";
import { PageLayout } from "@/components/layout/page-layout";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { getMyFactors } from "@/features/admin/queries";
import { requireViewer } from "@/features/account/queries";
import { safeNextPath } from "@/features/auth/redirect";
import { verifyStepUp } from "@/features/security/actions";
import { securityError } from "@/features/security/form";

export const metadata: Metadata = {
  title: "Verify",
};

const selectClass =
  "h-10 w-full rounded-lg border border-input bg-transparent px-3 text-base outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring md:text-sm dark:bg-input/30";

/**
 * A fresh TOTP verification (M8d): after signing in with a password, or when a staff
 * action asks for one. Afterwards the member goes back to `next` and submits again;
 * nothing they were doing is replayed for them.
 */
async function VerifyView({ searchParams }: { searchParams: PageProps<"/settings/security/verify">["searchParams"] }) {
  const search = await searchParams;
  const next = safeNextPath(param(search.next), "/settings/security");
  await requireViewer(`/settings/security/verify?next=${encodeURIComponent(next)}`);
  const factors = (await getMyFactors())?.filter((f) => f.status === "verified") ?? null;

  return (
    <div className="flex flex-col gap-4">
      <PageMessage notice={null} error={securityError(param(search.error))} />
      <AdminCard id="verify-form" title="Enter a code from your authenticator">
        {!factors ? (
          <p className="text-sm text-muted-foreground">Two-step verification isn&apos;t available right now. Try again later.</p>
        ) : !factors.length ? (
          <p className="text-sm">
            You have no verified authenticator.{" "}
            <Link href="/settings/security" className="text-primary-text underline underline-offset-4">
              Set one up
            </Link>
            .
          </p>
        ) : (
          <form action={verifyStepUp} className="flex flex-col gap-3">
            <input type="hidden" name="next" value={next} />
            {factors.length > 1 ? (
              <div className="flex min-w-0 flex-col gap-1.5">
                <label htmlFor="verify-factor" className="text-sm font-medium">
                  Authenticator
                </label>
                <select id="verify-factor" name="factor_id" className={selectClass}>
                  {factors.map((f) => (
                    <option key={f.id} value={f.id}>
                      {f.friendly_name ?? "Authenticator"}
                    </option>
                  ))}
                </select>
              </div>
            ) : (
              <input type="hidden" name="factor_id" value={factors[0].id} />
            )}
            <div className="flex min-w-0 flex-col gap-1.5">
              <label htmlFor="verify-code" className="text-sm font-medium">
                6-digit code
              </label>
              <Input id="verify-code" name="code" required inputMode="numeric" autoComplete="one-time-code" pattern="[0-9 ]{6,7}" maxLength={7} className="h-10 max-w-40 font-mono" />
            </div>
            <div>
              <Button type="submit" size="lg" className="h-10 px-4">
                Verify
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">Afterwards you go back to where you were, and can do what you started.</p>
          </form>
        )}
      </AdminCard>
    </div>
  );
}

export default function VerifyPage({ searchParams }: PageProps<"/settings/security/verify">) {
  return (
    <PageLayout>
      <div className="p-4 md:p-0">
        <h1 className="mb-4 text-xl font-semibold tracking-tight">Verify it&apos;s you</h1>
        <Suspense fallback={<AccountPageSkeleton />}>
          <VerifyView searchParams={searchParams} />
        </Suspense>
      </div>
    </PageLayout>
  );
}
