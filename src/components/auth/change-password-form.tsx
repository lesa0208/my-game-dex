import { PasswordFields } from "@/components/auth/password-fields";
import { PendingButton } from "@/components/auth/pending-button";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { changePassword, signInAgain } from "@/features/password/actions";

/**
 * Changes the signed-in account's password (M11a-2): the current one, then the new one
 * twice. Its errors come back in the page's URL; after "reauthenticate" it offers to sign
 * in again.
 */
export function ChangePasswordForm({ invalid, reauthenticate }: { invalid: boolean; reauthenticate: boolean }) {
  return (
    <div className="flex flex-col gap-4">
      {reauthenticate ? (
        <form action={signInAgain}>
          <Button type="submit" variant="outline" size="lg" className="h-10 px-4">
            Sign in again
          </Button>
        </form>
      ) : null}
      <form action={changePassword} className="flex flex-col gap-4" noValidate>
        <div className="flex flex-col gap-1.5">
          <label htmlFor="current-password" className="text-sm font-medium">
            Current password
          </label>
          <Input
            id="current-password"
            name="current_password"
            type="password"
            autoComplete="current-password"
            required
            maxLength={1024}
            className="h-10"
            aria-describedby={invalid ? "page-error" : undefined}
            aria-invalid={invalid ? true : undefined}
          />
        </div>
        <PasswordFields describedBy={invalid ? "page-error password-hint" : "password-hint"} invalid={invalid} />
        <PendingButton size="lg" className="h-10 self-start px-4" pendingLabel="Saving…">
          Change password
        </PendingButton>
      </form>
    </div>
  );
}
