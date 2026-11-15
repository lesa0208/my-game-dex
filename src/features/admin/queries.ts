import "server-only";

import { notFound, redirect } from "next/navigation";
import { cache } from "react";

import { requireViewerWithHandle } from "@/features/account/queries";
import { createSupabaseServerClient } from "@/features/auth/server";
import { UUID } from "@/features/collection/uuid";
import type { Viewer } from "@/types/user";

import { stepUpHref } from "./form";

/**
 * The unified /admin (M8d), read with the staff member's own session through the M8d
 * functions, which check the caller themselves. Never cached across requests: access
 * is always the database's live answer, so a role removed a moment ago is gone.
 */

export type AdminAccess = {
  roles: string[];
  active: boolean;
  mfa: boolean;
  recentMfa: boolean;
  staff: boolean;
  admin: boolean;
  moderator: boolean;
  editor: boolean;
  owner: boolean;
  ownerAuthority: string | null;
  recoveryPending: boolean;
  transferOffered: { id: string; from_handle: string | null; expires_at: string } | null;
  recoveryToConfirm: { id: string; hold_until: string; confirmed: boolean } | null;
};

/** Per request only (React's cache), from get_my_admin_access(). Null when signed out or unavailable. */
export const getAdminAccess = cache(async (): Promise<AdminAccess | null> => {
  const supabase = await createSupabaseServerClient();
  if (!supabase) return null;
  const { data: auth } = await supabase.auth.getClaims();
  if (!auth?.claims?.sub) return null;
  const { data, error } = await supabase.rpc("get_my_admin_access");
  if (error || typeof data !== "object" || data === null) return null;
  const d = data as Record<string, unknown>;
  return {
    roles: Array.isArray(d.roles) ? d.roles.filter((r): r is string => typeof r === "string") : [],
    active: d.active === true,
    mfa: d.mfa === true,
    recentMfa: d.recent_mfa === true,
    staff: d.staff === true,
    admin: d.admin === true,
    moderator: d.moderator === true,
    editor: d.editor === true,
    owner: d.owner === true,
    ownerAuthority: typeof d.owner_authority === "string" ? d.owner_authority : null,
    recoveryPending: d.recovery_pending === true,
    transferOffered: (d.transfer_offered as AdminAccess["transferOffered"]) ?? null,
    recoveryToConfirm: (d.recovery_to_confirm as AdminAccess["recoveryToConfirm"]) ?? null,
  };
});

export type Section = "staff" | "editor" | "moderator" | "admin";

/**
 * For an /admin page: the viewer and their access, or the page that doesn't exist for
 * anyone without the section's role (D8). A staff member whose session isn't verified
 * with their authenticator is sent to verify first, then back here.
 */
export async function requireAdminSection(path: string, section: Section): Promise<{ viewer: Viewer; access: AdminAccess }> {
  const viewer = await requireViewerWithHandle(path);
  const access = await getAdminAccess();
  if (!access) notFound();
  if (access.roles.length > 0 && access.active && !access.mfa) redirect(stepUpHref(path));
  if (!access[section]) notFound();
  return { viewer, access };
}

export type StaffMember = {
  id: string;
  handle: string | null;
  display_name: string | null;
  account_status: string;
  roles: string[];
  owner: boolean;
  successor: boolean;
};

export async function getStaffMembers(): Promise<StaffMember[] | null> {
  const supabase = await createSupabaseServerClient();
  if (!supabase) return null;
  const { data, error } = await supabase.rpc("get_staff_members");
  return error || !Array.isArray(data) ? null : (data as StaffMember[]);
}

export type Account = { id: string; handle: string; display_name: string | null; account_status: string; roles: string[]; owner: boolean };

/** One account by exact handle, null if none; "error" when it can't be read. */
export async function findAccount(handle: string): Promise<Account | null | "error"> {
  const supabase = await createSupabaseServerClient();
  if (!supabase) return "error";
  const { data, error } = await supabase.rpc("find_account_by_handle", { p_handle: handle });
  if (error) return "error";
  return data && typeof data === "object" && typeof (data as Account).id === "string" && UUID.test((data as Account).id) ? (data as Account) : null;
}

export type OwnershipStatus = {
  owner: { handle: string | null; display_name: string | null };
  assigned_at: string;
  version: number;
  successor_handle: string | null;
  document_registered_at: string | null;
  transfer: { id: string; from_handle: string | null; to_handle: string | null; created_at: string; expires_at: string; expired: boolean } | null;
  recovery: { id: string; kind: string; target_handle: string | null; created_at: string; hold_until: string; confirmed: boolean; disputed: boolean } | null;
  security_changed: boolean | null;
};

/** The Owner record and anything pending; null when no Owner is assigned, "error" when it can't be read. */
export async function getOwnershipStatus(): Promise<OwnershipStatus | null | "error"> {
  const supabase = await createSupabaseServerClient();
  if (!supabase) return "error";
  const { data, error } = await supabase.rpc("get_ownership_status");
  if (error) return "error";
  return (data as OwnershipStatus | null) ?? null;
}

export type AuditEvent = {
  id: string;
  occurred_at: string;
  action: string;
  reason: string;
  metadata: unknown;
  outcome: string;
  actor_handle: string | null;
  target_handle: string | null;
  actor_id: string | null;
  target_profile_id: string | null;
};

export type AuditFilters = { action: string | null; actor: string | null; target: string | null; since: string | null; until: string | null; before: string | null };

export async function getAuditEvents(filters: AuditFilters): Promise<{ events: AuditEvent[] } | { error: string }> {
  const supabase = await createSupabaseServerClient();
  if (!supabase) return { error: "failed" };
  const { data, error } = await supabase.rpc("get_audit_events", {
    p_limit: 50,
    p_before: filters.before,
    p_action: filters.action,
    p_actor_handle: filters.actor,
    p_target_handle: filters.target,
    p_since: filters.since,
    p_until: filters.until,
  });
  if (error) return { error: error.message === "invalid filter" ? "invalid_filter" : "failed" };
  return { events: Array.isArray(data) ? (data as AuditEvent[]) : [] };
}

export type Factor = {
  id: string;
  friendly_name: string | null;
  status: string;
  created_at: string;
  registered_at: string | null;
  matures_at: string | null;
  mature: boolean;
};

/** The viewer's own TOTP factors and their maturity (D13), never a secret. Null when unavailable. */
export async function getMyFactors(): Promise<Factor[] | null> {
  const supabase = await createSupabaseServerClient();
  if (!supabase) return null;
  const { data, error } = await supabase.rpc("get_my_factor_status");
  return error || !Array.isArray(data) ? null : (data as Factor[]);
}
