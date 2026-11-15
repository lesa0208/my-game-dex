"use client";

import { AtSign, FilePlus2, LogIn, LogOut, Settings, ShieldCheck, UserRound } from "lucide-react";
import Link from "next/link";

import { UserAvatar } from "@/components/shared/user-avatar";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { signOut } from "@/features/auth/actions";
import type { Viewer } from "@/types/user";

/** Shown while the session is read, with the same size as the menu. */
export function UserMenuPlaceholder() {
  return (
    <span aria-hidden="true" className="flex size-10 items-center justify-center text-muted-foreground">
      <UserRound className="size-5" />
    </span>
  );
}

/** `isStaff`: the account holds a staff role, from `get_my_admin_access()`; /admin checks it again. */
export function UserMenu({ viewer, isStaff = false }: { viewer: Viewer | null; isStaff?: boolean }) {
  if (!viewer) {
    return (
      <Button asChild variant="ghost" size="lg" className="h-10">
        <Link href="/sign-in">
          <LogIn aria-hidden="true" />
          Sign in
        </Link>
      </Button>
    );
  }

  return (
    <>
      {/* Outside the menu, which unmounts its content when it closes. */}
      <form id="sign-out-form" action={signOut} hidden />
      {/* Non-modal: a modal menu hides the rest of the page from assistive technology
          while it still has focusable elements, which axe reports. */}
      <DropdownMenu modal={false}>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="icon" aria-label="Account menu" className="size-10 rounded-full">
            <UserAvatar collector={viewer} size={32} />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-56">
          <DropdownMenuLabel className="font-normal">
            <span className="block truncate text-sm font-medium text-foreground">{viewer.displayName}</span>
            <span className="block truncate text-xs">{viewer.handle ? `@${viewer.handle}` : "No handle yet"}</span>
          </DropdownMenuLabel>
          <DropdownMenuSeparator />
          {viewer.handle ? (
            <>
              <DropdownMenuItem asChild>
                <Link href="/profile">
                  <UserRound aria-hidden="true" />
                  My Profile
                </Link>
              </DropdownMenuItem>
              <DropdownMenuItem asChild>
                <Link href="/submissions">
                  <FilePlus2 aria-hidden="true" />
                  My submissions
                </Link>
              </DropdownMenuItem>
              {isStaff ? (
                <DropdownMenuItem asChild>
                  <Link href="/admin">
                    <ShieldCheck aria-hidden="true" />
                    Admin
                  </Link>
                </DropdownMenuItem>
              ) : null}
              <DropdownMenuItem asChild>
                <Link href="/settings">
                  <Settings aria-hidden="true" />
                  Settings
                </Link>
              </DropdownMenuItem>
            </>
          ) : (
            <DropdownMenuItem asChild>
              <Link href="/welcome">
                <AtSign aria-hidden="true" />
                Choose your handle
              </Link>
            </DropdownMenuItem>
          )}
          <DropdownMenuSeparator />
          <DropdownMenuItem asChild>
            <button type="submit" form="sign-out-form" className="w-full">
              <LogOut aria-hidden="true" />
              Sign out
            </button>
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </>
  );
}
