export type Collector = {
  id: string;
  displayName: string;
  handle: string;
  avatarUrl?: string;
};

/** A collector as seen by the current viewer. */
export type SuggestedCollector = Collector & {
  gamesCataloged: number;
  focus: string;
};

/**
 * The signed-in account, from a verified session. `handle` is null until one is
 * claimed, and only an active account with a handle can use account features.
 */
export type Viewer = {
  id: string;
  handle: string | null;
  displayName: string;
  avatarUrl?: string;
  accountStatus: "active" | "suspended" | "deactivated";
  /** `private.is_active_user()`: active, verified email and a claimed handle. */
  isActive: boolean;
  handleChangedAt: string | null;
  handleCorrectionUntil: string | null;
};
