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

/**
 * The overview's counts (M10a), from get_admin_overview(). The database fills each
 * section only for the roles that may read it and leaves the rest null; every count
 * stops at `cap`. Aggregates only: no names, handles or records.
 */
export type AdminOverview = {
  cap: number;
  catalog: {
    submissions_open: number;
    submissions_in_review: number;
    submissions_changes_requested: number;
    oldest_waiting_at: string | null;
    reclassifications_open: number;
    games_unpublished: number;
    releases_unpublished: number;
    merges_30_days: number;
  } | null;
  accounts: { suspended: number } | null;
  administration: {
    exclusions_active: number;
    staff_admins: number;
    staff_moderators: number;
    staff_catalog_editors: number;
    refusals_7_days: number;
  } | null;
};

/** The overview's counts, or null when they can't be read. */
export async function getAdminOverview(): Promise<AdminOverview | null> {
  const supabase = await createSupabaseServerClient();
  if (!supabase) return null;
  const { data, error } = await supabase.rpc("get_admin_overview");
  if (error || typeof data !== "object" || data === null || typeof (data as AdminOverview).cap !== "number") return null;
  return data as AdminOverview;
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

export type Account = { id: string; handle: string; display_name: string | null; account_status: string; roles: string[]; owner: boolean };


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

/**
 * An audit event as the M10e reads return it: handles rather than account ids, and
 * only allow-listed details (plain values under known keys, and a game or release to
 * link to). Never the raw metadata.
 */
export type AuditEntry = {
  id: string;
  occurred_at: string;
  action: string;
  outcome: string;
  reason: string;
  by_account: boolean;
  actor_handle: string | null;
  about_account: boolean;
  target_handle: string | null;
  details: Record<string, string | number | boolean> & { record?: { entity: "game" | "release"; id: string } };
};

export type AuditFilters = {
  action: string | null;
  category: string | null;
  outcome: string | null;
  actor: string | null;
  target: string | null;
  since: string | null;
  until: string | null;
  before: string | null;
};

/** A page of the audit log (M10e), 50 at a time, for administrators. */
export async function getAuditLog(filters: AuditFilters): Promise<{ events: AuditEntry[] } | { error: string }> {
  const supabase = await createSupabaseServerClient();
  if (!supabase) return { error: "failed" };
  const { data, error } = await supabase.rpc("get_audit_log", {
    p_limit: 50,
    p_before: filters.before,
    p_action: filters.action,
    p_category: filters.category,
    p_outcome: filters.outcome,
    p_actor_handle: filters.actor,
    p_target_handle: filters.target,
    p_since: filters.since,
    p_until: filters.until,
  });
  if (error) return { error: error.message === "invalid filter" ? "invalid_filter" : "failed" };
  return Array.isArray(data) ? { events: data as AuditEntry[] } : { error: "failed" };
}

/** Accounts whose handle starts with the query (M10e), at most 25; "error" when they can't be read. */
export async function searchAccounts(query: string): Promise<Account[] | "error"> {
  const supabase = await createSupabaseServerClient();
  if (!supabase) return "error";
  const { data, error } = await supabase.rpc("search_accounts", { p_query: query, p_limit: 25 });
  if (error || !Array.isArray(data)) return "error";
  return (data as Account[]).filter((a) => typeof a.id === "string" && UUID.test(a.id));
}

export type AccountSummary = {
  cap: number;
  account: Account & { member_since: string };
  moderation: {
    suspensions: number;
    reinstatements: number;
    refused_status_changes: number;
    last_status_change: { at: string; action: string; actor_handle: string | null } | null;
  };
  /** Moderators see status history; administrators also staff-role history. */
  history: AuditEntry[];
};

/** One account's summary by exact handle (M10e): null if none, "error" when it can't be read. */
export async function getAccountSummary(handle: string): Promise<AccountSummary | null | "error"> {
  const supabase = await createSupabaseServerClient();
  if (!supabase) return "error";
  const { data, error } = await supabase.rpc("get_account_summary", { p_handle: handle });
  if (error) return "error";
  if (data === null) return null;
  const d = data as AccountSummary;
  return typeof d === "object" && typeof d.account?.id === "string" && UUID.test(d.account.id) && Array.isArray(d.history) ? d : "error";
}

export type StaffOverviewMember = StaffMember & {
  standing: "active" | "suspended" | "deactivated" | "unverified" | "no_handle" | "banned" | "deleted" | "unavailable";
  /** Verified authenticator factors, and those registered at least 24 hours ago: counts only. */
  factors: number | null;
  mature_factors: number | null;
  last_staff_action_at: string | null;
};

export type StaffOverview = {
  cap: number;
  roles: { admin: number; moderator: number; catalog_editor: number };
  members: StaffOverviewMember[];
  recent: AuditEntry[];
};

/** The staff overview (M10e), for administrators; null when it can't be read. */
export async function getStaffOverview(): Promise<StaffOverview | null> {
  const supabase = await createSupabaseServerClient();
  if (!supabase) return null;
  const { data, error } = await supabase.rpc("get_staff_overview");
  if (error || typeof data !== "object" || data === null) return null;
  const d = data as StaffOverview;
  return Array.isArray(d.members) && Array.isArray(d.recent) ? d : null;
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
