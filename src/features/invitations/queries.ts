import "server-only";

import { createSupabaseServerClient } from "@/features/auth/server";
import { UUID } from "@/features/collection/uuid";

import { isInvitationStatus, type InvitationStatus } from "./form";

export type InvitationEntry = {
  id: string;
  /** Masked by the database, never the address. */
  email: string;
  status: InvitationStatus;
  invited_by: string | null;
  created_at: string;
  last_sent_at: string | null;
  resends_left: number;
  next_resend_at: string | null;
  revoked_at: string | null;
  /** Whether the 10-minute wait since the last email is over, as of reading. */
  resend_ready: boolean;
};

export type InvitationList = {
  limits: { mine: number; mine_max: number; total: number; total_max: number };
  invitations: InvitationEntry[];
};

/** The invitations for administrators (M11a-1), newest first; null when they can't be read. */
export async function getInvitations(before: string | null): Promise<InvitationList | null> {
  const supabase = await createSupabaseServerClient();
  if (!supabase) return null;
  const { data, error } = await supabase.rpc("get_account_invitations", { p_limit: 50, p_before: before && UUID.test(before) ? before : null });
  if (error || typeof data !== "object" || data === null) return null;
  const d = data as InvitationList;
  if (!Array.isArray(d.invitations) || typeof d.limits !== "object") return null;
  const now = Date.now();
  return {
    limits: d.limits,
    invitations: d.invitations
      .filter((i) => typeof i.id === "string" && UUID.test(i.id) && isInvitationStatus(i.status))
      .map((i) => ({ ...i, resend_ready: !i.next_resend_at || new Date(i.next_resend_at).getTime() <= now })),
  };
}

export type Onboarding = { invited: boolean; password_set: boolean; revoked: boolean };

/** The signed-in person's own onboarding state, or null when it can't be read. */
export async function getMyOnboarding(): Promise<Onboarding | null> {
  const supabase = await createSupabaseServerClient();
  if (!supabase) return null;
  const { data, error } = await supabase.rpc("get_my_onboarding");
  if (error || typeof data !== "object" || data === null) return null;
  const d = data as Onboarding;
  return { invited: d.invited === true, password_set: d.password_set === true, revoked: d.revoked === true };
}
