import { Input } from "@/components/ui/input";

/** A new password and its confirmation, with the rule in the hint (M11a-1, M11a-2). */
export function PasswordFields({ describedBy, invalid }: { describedBy: string; invalid: boolean }) {
  return (
    <>
      <div className="flex flex-col gap-1.5">
        <label htmlFor="password" className="text-sm font-medium">
          New password
        </label>
        <Input
          id="password"
          name="password"
          type="password"
          autoComplete="new-password"
          required
          minLength={12}
          className="h-10"
          aria-describedby={describedBy}
          aria-invalid={invalid ? true : undefined}
        />
        <p id="password-hint" className="text-xs text-muted-foreground">
          At least 12 characters. A few unrelated words make a strong one.
        </p>
      </div>
      <div className="flex flex-col gap-1.5">
        <label htmlFor="confirm" className="text-sm font-medium">
          The same password again
        </label>
        <Input id="confirm" name="confirm" type="password" autoComplete="new-password" required minLength={12} className="h-10" aria-invalid={invalid ? true : undefined} />
      </div>
    </>
  );
}
