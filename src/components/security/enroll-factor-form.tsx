"use client";

import { CircleAlert } from "lucide-react";
import { useActionState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { enrollFactor, type EnrollState, verifyEnrollment } from "@/features/security/actions";
import { FACTOR_NAME_MAX } from "@/features/security/form";

/**
 * Adding an authenticator (M8d). Step one asks Auth for a new TOTP factor and shows its
 * QR code and secret here, once: they're never put in a URL or stored by the app. Step
 * two verifies the first code, which registers the factor. Showing the code needs
 * JavaScript; anyone who scanned it but left before entering a code finishes from the
 * "Finish setting up" form on the Security page, which doesn't.
 */
export function EnrollFactorForm() {
  const [state, action, pending] = useActionState<EnrollState, FormData>(enrollFactor, { status: "idle", message: null });

  if (state.status === "enrolled") {
    return (
      <div className="flex flex-col gap-4">
        <p className="text-sm">
          Scan this code with your authenticator app, or type the setup key, then enter the 6-digit code it shows. Keep the key private: anyone with it can make codes for
          your account.
        </p>
        {/* Auth returns the QR code as an SVG data URL; it never leaves this page. */}
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={state.qrCode} alt="QR code to add this account to an authenticator app" width={176} height={176} className="rounded-lg border bg-white p-2" />
        <div className="flex min-w-0 flex-col gap-1.5">
          <p id="enroll-secret-label" className="text-sm font-medium">
            Setup key
          </p>
          <code className="rounded-lg border bg-muted px-3 py-2 font-mono text-sm break-all" data-totp-secret="">
            {state.secret}
          </code>
        </div>
        <form action={verifyEnrollment} className="flex flex-col gap-3">
          <input type="hidden" name="factor_id" value={state.factorId} />
          <div className="flex min-w-0 flex-col gap-1.5">
            <label htmlFor="enroll-code" className="text-sm font-medium">
              Code from {state.name}
            </label>
            <Input id="enroll-code" name="code" required inputMode="numeric" autoComplete="one-time-code" pattern="[0-9 ]{6,7}" maxLength={7} className="h-10 max-w-40 font-mono" />
          </div>
          <div>
            <Button type="submit" size="lg" className="h-10 px-4">
              Verify and add
            </Button>
          </div>
        </form>
      </div>
    );
  }

  return (
    <form action={action} className="flex flex-col gap-3">
      <div className="flex min-w-0 flex-col gap-1.5">
        <label htmlFor="enroll-name" className="text-sm font-medium">
          Name for this authenticator
        </label>
        <Input id="enroll-name" name="name" required maxLength={FACTOR_NAME_MAX} defaultValue="Authenticator app" autoComplete="off" aria-describedby="enroll-name-hint" className="h-10" />
        <p id="enroll-name-hint" className="text-xs text-muted-foreground">
          So you can tell your devices apart, such as &ldquo;Phone&rdquo; or &ldquo;Backup key&rdquo;.
        </p>
      </div>
      <div>
        <Button type="submit" variant="secondary" size="lg" className="h-10 px-4" aria-disabled={pending || undefined}>
          {pending ? "Starting…" : "Add an authenticator"}
        </Button>
      </div>
      <div role="alert" aria-live="assertive">
        {state.status === "error" && state.message ? (
          <p className="flex gap-2 rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2.5 text-sm text-destructive">
            <CircleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
            {state.message}
          </p>
        ) : null}
      </div>
    </form>
  );
}
