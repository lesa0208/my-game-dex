"use server";

import { refresh } from "next/cache";
import { redirect } from "next/navigation";

import { HANDLE_ERROR_MESSAGES, HANDLE_PATTERN, handleErrorFrom } from "./account";
import { safeNextPath, signInHref } from "./redirect";
import { createSupabaseServerClient } from "./server";

/**
 * Sign-in, sign-out and the handle claim. Each action also runs without JavaScript,
 * though its messages then don't show (the page is rendered afresh). Each verifies what it needs itself rather than trusting the page that rendered it, and
 * returns only fixed messages: nothing from Auth or the database reaches the page.
 * Next.js checks that a Server Action request comes from this site.
 *
 * Each successful action calls `refresh()`: signing in, out or claiming a handle
 * changes what every page shows, so the browser must not reuse pages it rendered
 * before. It refreshes only the client router, not server caches such as the catalog.
 */

export type FormState = { error: string | null };

const UNAVAILABLE = "Signing in isn't available right now. Try again later.";

function field(formData: FormData, name: string): string {
  const value = formData.get(name);
  return typeof value === "string" ? value : "";
}

export async function signIn(_state: FormState, formData: FormData): Promise<FormState> {
  const email = field(formData, "email").trim();
  const password = field(formData, "password");
  const next = safeNextPath(field(formData, "next"));

  if (!email || !password) return { error: "Enter your email and password." };
  if (email.length > 254 || password.length > 1024) return { error: "Your email or password is incorrect." };

  const supabase = await createSupabaseServerClient();
  if (!supabase) return { error: UNAVAILABLE };

  const { error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) {
    // Only reachable with the right password, so it doesn't reveal that an email exists.
    if (error.code === "email_not_confirmed") return { error: "Confirm your email with the link we sent, then sign in." };
    if (error.status === 429) return { error: "Too many attempts. Wait a few minutes, then try again." };
    // Wrong password and unknown email get the same answer (M2).
    if (error.status && error.status < 500) return { error: "Your email or password is incorrect." };
    return { error: UNAVAILABLE };
  }
  refresh();
  redirect(next);
}

export async function signOut(): Promise<void> {
  const supabase = await createSupabaseServerClient();
  // Ends this device's session in Auth and clears its cookies. Other devices stay signed in.
  if (supabase) await supabase.auth.signOut({ scope: "local" });
  refresh();
  redirect("/sign-in");
}

export async function claimHandle(_state: FormState, formData: FormData): Promise<FormState> {
  const handle = field(formData, "handle").trim();
  const next = safeNextPath(field(formData, "next"));
  if (!HANDLE_PATTERN.test(handle)) return { error: HANDLE_ERROR_MESSAGES.invalid };

  const supabase = await createSupabaseServerClient();
  if (!supabase) return { error: HANDLE_ERROR_MESSAGES.failed };
  const { data: auth } = await supabase.auth.getClaims();
  if (!auth?.claims?.sub) redirect(signInHref("/welcome"));

  // claim_handle (M2) takes the caller from auth.uid() and enforces every rule.
  const { error } = await supabase.rpc("claim_handle", { p_handle: handle });
  if (error) return { error: HANDLE_ERROR_MESSAGES[handleErrorFrom(error.message)] };
  refresh();
  redirect(next);
}
