"use client";

import { X } from "lucide-react";
import { Dialog as DialogPrimitive } from "radix-ui";
import type { ComponentProps, ReactNode } from "react";

import { cn } from "@/lib/utils";

/**
 * An accessible modal (Radix): focus moves in and is kept there, Escape and the close
 * button close it, focus returns to what opened it, and the page behind is inert. On a
 * phone it rises from the bottom as a sheet; from 640px it's centred.
 */
export const Dialog = DialogPrimitive.Root;
export const DialogTrigger = DialogPrimitive.Trigger;
export const DialogClose = DialogPrimitive.Close;

export function DialogContent({ className, children, title, description, ...props }: ComponentProps<typeof DialogPrimitive.Content> & { title: ReactNode; description?: ReactNode }) {
  return (
    <DialogPrimitive.Portal>
      <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-black/70 backdrop-blur-[2px] data-[state=open]:animate-in data-[state=open]:fade-in-0 motion-reduce:animate-none" />
      <DialogPrimitive.Content
        {...props}
        // Without a description, Radix would warn; one is always given or opted out.
        aria-describedby={description ? undefined : props["aria-describedby"]}
        className={cn(
          "fixed z-50 flex max-h-[92dvh] w-full flex-col overflow-hidden border border-white/10 bg-[#16151c] text-foreground shadow-[0_32px_80px_-16px_rgb(0_0_0/0.9)] outline-none",
          "inset-x-0 bottom-0 rounded-t-2xl sm:inset-x-auto sm:top-1/2 sm:bottom-auto sm:left-1/2 sm:max-w-lg sm:-translate-x-1/2 sm:-translate-y-1/2 sm:rounded-2xl",
          className,
        )}
      >
        <div className="flex items-start justify-between gap-3 border-b border-white/[0.07] px-5 pt-4 pb-3">
          <div className="min-w-0">
            <DialogPrimitive.Title className="text-lg leading-tight font-semibold text-pretty">{title}</DialogPrimitive.Title>
            {description ? <DialogPrimitive.Description className="mt-0.5 text-sm text-muted-foreground">{description}</DialogPrimitive.Description> : null}
          </div>
          <DialogPrimitive.Close
            aria-label="Close"
            className="-mr-1.5 flex size-10 shrink-0 items-center justify-center rounded-lg text-muted-foreground outline-none hover:bg-white/5 hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring"
          >
            <X aria-hidden="true" className="size-5" />
          </DialogPrimitive.Close>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4 pb-[max(1rem,env(safe-area-inset-bottom))]">{children}</div>
      </DialogPrimitive.Content>
    </DialogPrimitive.Portal>
  );
}
