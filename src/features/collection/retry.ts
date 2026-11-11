import type { AddCopyState } from "./actions";

export const UNCONFIRMED = "We couldn't confirm the copy was added. Try again: it won't be added twice.";

/**
 * Wraps the add action for the page. If the request fails on the way (say the
 * connection drops after the server added the copy), the form keeps the id it sent, so
 * a retry gets the same copy back. Without this, the failure would reach the page's
 * error boundary, and trying again would render the form with a new id.
 */
export function keepingIdOnFailure(
  action: (state: AddCopyState, formData: FormData) => Promise<AddCopyState>,
): (state: AddCopyState, formData: FormData) => Promise<AddCopyState> {
  return async (state, formData) => {
    try {
      return await action(state, formData);
    } catch {
      return { ...state, status: "error", message: UNCONFIRMED };
    }
  };
}
