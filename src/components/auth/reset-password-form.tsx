import { PasswordFields } from "@/components/auth/password-fields";
import { PendingButton } from "@/components/auth/pending-button";
import { resetPassword } from "@/features/password/actions";

/** Chooses a new password with a reset link's session (M11a-2). Its errors come back in the page's URL. */
export function ResetPasswordForm({ invalid }: { invalid: boolean }) {
  return (
    <form action={resetPassword} className="flex flex-col gap-4" noValidate>
      <PasswordFields describedBy={invalid ? "page-error password-hint" : "password-hint"} invalid={invalid} />
      <PendingButton size="lg" className="h-10 self-start px-4" pendingLabel="Saving…">
        Save the new password
      </PendingButton>
    </form>
  );
}
