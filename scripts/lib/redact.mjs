/** Removes local keys, tokens and passwords from Supabase CLI output before it's shown. */
export function redact(text) {
  return text
    .replace(/sb_(secret|publishable)_[A-Za-z0-9_-]+/g, "[REDACTED]")
    .replace(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*/g, "[REDACTED]")
    .replace(/(postgres(?:ql)?:\/\/[^:\s"]+:)[^@\s"]+@/g, "$1[REDACTED]@")
    .replace(/"([A-Z0-9_]*(?:SECRET|KEY|PASSWORD|TOKEN)[A-Z0-9_]*)"\s*:\s*"[^"]*"/g, '"$1":"[REDACTED]"');
}
