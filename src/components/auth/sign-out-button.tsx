import { LogOut } from "lucide-react";

import { Button } from "@/components/ui/button";
import { signOut } from "@/features/auth/actions";

/** A POST form, so signing out can't be triggered by a link or an image. */
export function SignOutButton() {
  return (
    <form action={signOut}>
      <Button type="submit" variant="secondary" size="lg">
        <LogOut aria-hidden="true" />
        Sign out
      </Button>
    </form>
  );
}
