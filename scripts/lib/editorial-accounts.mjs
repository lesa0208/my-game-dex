/**
 * Editor addresses on the editorial stacks (scripts/catalog-b1-review.mjs). Pure, so it is tested
 * without a stack (scripts/pilot-stack.test.mjs).
 *
 * B1 keeps its disposable @example.test addresses, exactly as before. On the M15 pilot every editor
 * is a real person who registers with their own address: the pilot is local only, sends no mail
 * (sign-up is off and accounts are created already confirmed), and no address leaves this computer.
 */

/** Why an --email is unacceptable on this editorial stack, or null when it is acceptable. */
export function editorEmailProblem(email, target) {
  if (typeof email !== "string") return "--email is required.";
  if (target.disposableEditor) {
    return /^[a-z0-9._+-]{1,64}@example\.test$/.test(email) ? null : "--email must be a disposable test address ending in @example.test.";
  }
  if (email.endsWith("@example.test")) return "Refusing: on the pilot every editor is a real person; @example.test addresses are for disposable stacks.";
  return email.length <= 254 && /^[a-z0-9._+-]{1,64}@[a-z0-9-]{1,63}(\.[a-z0-9-]{1,63})+$/.test(email) ? null : "--email must be the editor's own address (letters, digits and . _ + - only).";
}
