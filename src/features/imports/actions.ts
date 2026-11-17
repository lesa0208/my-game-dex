"use server";

import { refresh } from "next/cache";
import { redirect } from "next/navigation";

import { signInHref } from "@/features/auth/redirect";
import { createSupabaseServerClient } from "@/features/auth/server";
import { stepUpHref } from "@/features/admin/form";

import { readId, readResolution } from "./form";

const QUEUE = "/admin/catalog/reclassifications";

function field(formData: FormData, name: string): string {
  const value = formData.get(name);
  return typeof value === "string" ? value : "";
}

/**
 * Resolves one reclassification item (M5b) through the existing resolve_catalog_review:
 * an audited write, for catalog editors, that records the resolution and changes no
 * catalog record. It runs without JavaScript and redirects back with a fixed notice or
 * error code, never with anything the database said.
 */
export async function resolveReclassification(formData: FormData): Promise<void> {
  const id = readId(field(formData, "item_id"));
  if (!id) redirect(`${QUEUE}?error=unavailable`);
  const resolution = readResolution(field(formData, "resolution"));
  if ("error" in resolution) redirect(`${QUEUE}?error=reason`);
  const supabase = await createSupabaseServerClient();
  if (!supabase) redirect(`${QUEUE}?error=failed`);
  const { data: auth } = await supabase.auth.getClaims();
  if (!auth?.claims?.sub) redirect(signInHref(QUEUE));
  const { error } = await supabase.rpc("resolve_catalog_review", { p_id: id, p_resolution: resolution.value });
  if (error) {
    if (error.message === "reauthentication required") redirect(stepUpHref(QUEUE));
    redirect(`${QUEUE}?error=${error.message === "record unavailable" ? "unavailable" : error.message === "reason required" ? "reason" : "failed"}`);
  }
  refresh();
  redirect(`${QUEUE}?notice=resolved`);
}
