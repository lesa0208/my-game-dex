import "server-only";

/**
 * Self-registration (M16): whether a visitor may create their own collector account here.
 *
 * Off everywhere unless this server's own environment says `MGD_SELF_REGISTRATION=open`. Only the
 * local demo preview sets it (scripts/demo-preview.mjs), as a server-side process variable, never a
 * NEXT_PUBLIC_ one, so no browser or request can turn it on. Everything else stays invitation only
 * (M11a-1): the sign-up page doesn't exist there, and the sign-up action refuses before anything
 * reaches Auth. Independently, each stack's Auth decides too: the SNES pilot's has sign-up off
 * (scripts/test-stack.mjs), so even this flag couldn't create an account there.
 */
export function selfRegistrationOpen(env: Record<string, string | undefined> = process.env): boolean {
  return env.MGD_SELF_REGISTRATION === "open";
}
