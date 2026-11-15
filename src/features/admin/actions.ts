"use server";

import { refresh } from "next/cache";
import { redirect } from "next/navigation";

import { createSupabaseServerClient } from "@/features/auth/server";
import { signInHref } from "@/features/auth/redirect";
import { UUID } from "@/features/collection/uuid";

import { errorCode, isRole, readFingerprint, readHandle, readReason, returnPath, stepUpHref, withParam } from "./form";

/**
 * Staff, account and ownership actions in /admin (M8d). Each runs without JavaScript:
 * it redirects back to the page it came from with a notice or an error code, never
 * with anything the database said. The database checks every rule again (M8c); the
 * page only offers what it expects to be allowed.
 *
 * When the database asks for a fresh verification, the staff member is sent to verify
 * with their authenticator and then back to the same page, where they submit again:
 * nothing is replayed for them.
 */

type Result = { ok?: boolean; result?: string; refusal?: string };

function field(formData: FormData, name: string): string {
  const value = formData.get(name);
  return typeof value === "string" ? value : "";
}

async function signedInClient(back: string) {
  const supabase = await createSupabaseServerClient();
  if (!supabase) redirect(withParam(back, "error", "failed"));
  const { data: auth } = await supabase.auth.getClaims();
  if (!auth?.claims?.sub) redirect(signInHref(back));
  return supabase;
}

/** Calls a staff function and redirects with its outcome. Never returns. */
async function run(back: string, fn: string, args: Record<string, unknown>, notice: string): Promise<never> {
  const supabase = await signedInClient(back);
  const { data, error } = await supabase.rpc(fn, args);
  if (error) {
    if (error.message === "reauthentication required") redirect(stepUpHref(back));
    redirect(withParam(back, "error", errorCode(error.message)));
  }
  const result = (data ?? {}) as Result;
  refresh();
  if (result.ok !== true) redirect(withParam(back, "error", typeof result.refusal === "string" ? result.refusal : "failed"));
  redirect(withParam(back, "notice", result.result === "unchanged" ? "unchanged" : notice));
}

/** Finds an account's id by handle, or redirects back with an error. */
async function accountId(back: string, rawHandle: string): Promise<string> {
  const handle = readHandle(rawHandle);
  if (!handle) redirect(withParam(back, "error", "invalid_input"));
  const supabase = await signedInClient(back);
  const { data, error } = await supabase.rpc("find_account_by_handle", { p_handle: handle });
  if (error) redirect(withParam(back, "error", errorCode(error.message)));
  const id = (data as { id?: unknown } | null)?.id;
  if (typeof id !== "string" || !UUID.test(id)) redirect(withParam(back, "error", "not_found"));
  return id;
}

function reasonOrBack(back: string, formData: FormData): string {
  const reason = readReason(field(formData, "reason"));
  if (!reason) redirect(withParam(back, "error", "reason_required"));
  return reason;
}

export async function grantRole(formData: FormData): Promise<void> {
  const back = returnPath(field(formData, "back"), "/admin/staff");
  const role = field(formData, "role");
  if (!isRole(role)) redirect(withParam(back, "error", "invalid_input"));
  const reason = reasonOrBack(back, formData);
  const user = await accountId(back, field(formData, "handle"));
  await run(back, "grant_staff_role", { p_user: user, p_role: role, p_reason: reason }, "granted");
}

export async function revokeRole(formData: FormData): Promise<void> {
  const back = returnPath(field(formData, "back"), "/admin/staff");
  const role = field(formData, "role");
  const user = field(formData, "user_id");
  if (!isRole(role) || !UUID.test(user)) redirect(withParam(back, "error", "invalid_input"));
  const reason = reasonOrBack(back, formData);
  await run(back, "revoke_staff_role", { p_user: user, p_role: role, p_reason: reason }, "revoked");
}

export async function setAccountStatus(formData: FormData): Promise<void> {
  const back = returnPath(field(formData, "back"), "/admin/accounts");
  const status = field(formData, "status");
  const user = field(formData, "user_id");
  if ((status !== "active" && status !== "suspended") || !UUID.test(user)) redirect(withParam(back, "error", "invalid_input"));
  const reason = reasonOrBack(back, formData);
  await run(back, "set_account_status", { p_user: user, p_status: status, p_reason: reason }, status === "suspended" ? "suspended" : "reinstated");
}

const OWNERSHIP = "/admin/ownership";

export async function startTransfer(formData: FormData): Promise<void> {
  const reason = reasonOrBack(OWNERSHIP, formData);
  const user = await accountId(OWNERSHIP, field(formData, "handle"));
  await run(OWNERSHIP, "start_ownership_transfer", { p_to: user, p_reason: reason }, "transfer_started");
}

export async function acceptTransfer(formData: FormData): Promise<void> {
  const id = field(formData, "transfer_id");
  if (!UUID.test(id)) redirect(withParam(OWNERSHIP, "error", "invalid_input"));
  await run(OWNERSHIP, "accept_ownership_transfer", { p_transfer: id }, "transfer_accepted");
}

export async function cancelTransfer(formData: FormData): Promise<void> {
  const id = field(formData, "transfer_id");
  if (!UUID.test(id)) redirect(withParam(OWNERSHIP, "error", "invalid_input"));
  const reason = reasonOrBack(OWNERSHIP, formData);
  await run(OWNERSHIP, "cancel_ownership_transfer", { p_transfer: id, p_reason: reason }, field(formData, "as") === "target" ? "transfer_declined" : "transfer_cancelled");
}

export async function setSuccessor(formData: FormData): Promise<void> {
  const reason = reasonOrBack(OWNERSHIP, formData);
  const clear = field(formData, "clear") === "yes";
  const user = clear ? null : await accountId(OWNERSHIP, field(formData, "handle"));
  await run(OWNERSHIP, "set_owner_successor", { p_successor: user, p_reason: reason }, "successor_set");
}

export async function registerDocument(formData: FormData): Promise<void> {
  const reason = reasonOrBack(OWNERSHIP, formData);
  const clear = field(formData, "clear") === "yes";
  const fingerprint = clear ? null : readFingerprint(field(formData, "fingerprint"));
  if (!clear && !fingerprint) redirect(withParam(OWNERSHIP, "error", "invalid_fingerprint"));
  await run(OWNERSHIP, "register_succession_document", { p_fingerprint: fingerprint, p_reason: reason }, "document_registered");
}

export async function cancelRecovery(formData: FormData): Promise<void> {
  const id = field(formData, "recovery_id");
  if (!UUID.test(id)) redirect(withParam(OWNERSHIP, "error", "invalid_input"));
  const reason = reasonOrBack(OWNERSHIP, formData);
  await run(OWNERSHIP, "cancel_owner_recovery", { p_recovery: id, p_reason: reason }, "recovery_cancelled");
}

/** The target of a reassignment confirms it, from Settings → Security (they may not be staff). */
export async function confirmRecovery(formData: FormData): Promise<void> {
  const back = "/settings/security";
  const id = field(formData, "recovery_id");
  if (!UUID.test(id)) redirect(withParam(back, "error", "invalid_input"));
  await run(back, "confirm_owner_recovery", { p_recovery: id }, "recovery_confirmed");
}
