import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";

import { AdminCard, PageMessage, param } from "@/components/admin/admin-frame";
import { AccountPageSkeleton } from "@/components/auth/require-account";
import { PageLayout } from "@/components/layout/page-layout";
import { EnrollFactorForm } from "@/components/security/enroll-factor-form";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { confirmRecovery } from "@/features/admin/actions";
import { pageError } from "@/features/admin/form";
import { getAdminAccess, getMyFactors } from "@/features/admin/queries";
import { requireViewer } from "@/features/account/queries";
import { removeFactor, verifyEnrollment } from "@/features/security/actions";
import { maturityText, securityError, securityNotice } from "@/features/security/form";

export const metadata: Metadata = {
  title: "Security",
};

function when(at: string): string {
  return new Date(at).toLocaleString("en", { dateStyle: "medium", timeStyle: "short", timeZone: "UTC" }) + " UTC";
}

async function SecuritySettings({ searchParams }: { searchParams: PageProps<"/settings/security">["searchParams"] }) {
  const search = await searchParams;
  await requireViewer("/settings/security");
  const [factors, access] = await Promise.all([getMyFactors(), getAdminAccess()]);
  const verified = factors?.filter((f) => f.status === "verified") ?? [];
  const staff = (access?.roles.length ?? 0) > 0;
  const error = securityError(param(search.error)) ?? pageError(param(search.error));

  return (
    <div className="flex flex-col gap-6">
      <PageMessage notice={securityNotice(param(search.notice))} error={error} />
      {access?.recoveryToConfirm ? (
        <AdminCard id="security-recovery" title="An ownership recovery names you">
          <p className="text-sm">
            An operator opened a recovery that would make you the Owner. It can complete after {when(access.recoveryToConfirm.hold_until)}, and only once you confirm.
            Confirm only if you expected this.
          </p>
          {access.recoveryToConfirm.confirmed ? (
            <p className="mt-3 text-sm font-medium">You have confirmed it.</p>
          ) : (
            <form action={confirmRecovery} className="mt-3">
              <input type="hidden" name="recovery_id" value={access.recoveryToConfirm.id} />
              <Button type="submit" size="lg" className="h-10 px-4">
                Confirm the recovery
              </Button>
            </form>
          )}
        </AdminCard>
      ) : null}

      <AdminCard id="security-factors" title="Authenticators">
        {!factors ? (
          <p className="text-sm text-muted-foreground">Your authenticators can&apos;t be read right now. Try again later.</p>
        ) : factors.length ? (
          <ul className="flex flex-col divide-y">
            {factors.map((f) => (
              <li key={f.id} className="flex flex-col gap-2 py-3">
                <p className="text-sm">
                  <span className="font-medium">{f.friendly_name ?? "Authenticator"}</span>
                  <span className="block text-muted-foreground">
                    Added {when(f.created_at)}. {maturityText(f)}.
                  </span>
                </p>
                {f.status !== "verified" ? (
                  // Someone who scanned the code but left before entering it finishes here.
                  <form action={verifyEnrollment} className="flex flex-wrap items-end gap-3">
                    <input type="hidden" name="factor_id" value={f.id} />
                    <div className="flex min-w-0 flex-col gap-1.5">
                      <label htmlFor={`finish-${f.id}`} className="text-sm font-medium">
                        Code from {f.friendly_name ?? "this authenticator"}
                      </label>
                      <Input id={`finish-${f.id}`} name="code" required inputMode="numeric" autoComplete="one-time-code" pattern="[0-9 ]{6,7}" maxLength={7} className="h-10 max-w-40 font-mono" />
                    </div>
                    <Button type="submit" variant="secondary" size="lg" className="h-10 px-4">
                      Finish setting up
                    </Button>
                  </form>
                ) : null}
                <form action={removeFactor} className="flex flex-wrap items-center gap-3">
                  <input type="hidden" name="factor_id" value={f.id} />
                  <span className="flex items-center gap-2">
                    <input id={`remove-${f.id}`} name="confirm" type="checkbox" value="yes" required className="size-5 accent-destructive" />
                    <label htmlFor={`remove-${f.id}`} className="text-sm">
                      Remove {f.friendly_name ?? "this authenticator"}
                    </label>
                  </span>
                  <Button type="submit" variant="destructive" size="lg" className="h-10 px-4">
                    Remove
                  </Button>
                </form>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-muted-foreground">No authenticator yet. Staff need one: staff abilities work only after signing in with it.</p>
        )}
        {staff ? (
          <p className="mt-3 text-xs text-muted-foreground">
            Staff can&apos;t remove their last verified authenticator here. {access?.owner ? "As the Owner, keep two: Owner actions need two, each registered at least 24 hours ago." : ""}
          </p>
        ) : null}
      </AdminCard>

      <AdminCard id="security-add" title={verified.length ? "Add another authenticator" : "Set up an authenticator"}>
        {verified.length && !access?.mfa ? (
          <p className="text-sm">
            To add or remove one, first{" "}
            <Link href="/settings/security/verify?next=%2Fsettings%2Fsecurity" className="text-primary-text underline underline-offset-4">
              verify with an authenticator you have
            </Link>
            .
          </p>
        ) : (
          <EnrollFactorForm />
        )}
        {verified.length === 1 ? <p className="mt-3 text-xs text-muted-foreground">A second authenticator, kept somewhere safe, lets you get back in if you lose this one.</p> : null}
      </AdminCard>
    </div>
  );
}

export default function SecuritySettingsPage({ searchParams }: PageProps<"/settings/security">) {
  return (
    <PageLayout>
      <div className="p-4 md:p-0">
        <p className="mb-1">
          <Link href="/settings" className="text-sm text-primary-text underline-offset-4 hover:underline">
            Settings
          </Link>
        </p>
        <h1 className="mb-4 text-xl font-semibold tracking-tight">Security</h1>
        <Suspense fallback={<AccountPageSkeleton />}>
          <SecuritySettings searchParams={searchParams} />
        </Suspense>
      </div>
    </PageLayout>
  );
}
