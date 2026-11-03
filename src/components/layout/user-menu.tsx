"use client";

import { Settings, UserRound } from "lucide-react";
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
import type { Collector } from "@/types/user";

export function UserMenu({ viewer }: { viewer: Collector | null }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          aria-label="Account menu"
          className="size-10 rounded-full"
        >
          {viewer ? (
            <UserAvatar collector={viewer} size={32} />
          ) : (
            <UserRound aria-hidden="true" className="size-5" />
          )}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-56">
        <DropdownMenuLabel className="font-normal">
          {viewer ? (
            <>
              <span className="block text-sm font-medium text-foreground">
                {viewer.displayName}
              </span>
              <span className="block text-xs">Development preview account</span>
            </>
          ) : (
            <span className="block text-xs">Accounts aren&apos;t available yet</span>
          )}
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem asChild>
          <Link href="/profile">
            <UserRound aria-hidden="true" />
            My Profile
          </Link>
        </DropdownMenuItem>
        <DropdownMenuItem asChild>
          <Link href="/settings">
            <Settings aria-hidden="true" />
            Settings
          </Link>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
