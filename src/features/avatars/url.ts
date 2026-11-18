/**
 * Where a profile's avatar is served from (M11a-3): the public `avatars` bucket (M2),
 * which anyone can read, as the profile card can be. Only a path in the owner's folder
 * with the workflow's random name is turned into a URL, the same rule as the CHECK on
 * profiles.avatar_path, so a stored value can never point the page somewhere else.
 * The Supabase URL is a server variable; it isn't secret, and appears in the address.
 */
const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const PATH = new RegExp(`^(${UUID})/${UUID}\.webp$`);

export function avatarPublicUrl(path: string | null | undefined, ownerId: string, base: string | undefined = process.env.SUPABASE_URL): string | null {
  if (!path || !base) return null;
  const match = PATH.exec(path);
  if (!match || match[1] !== ownerId) return null;
  return `${base.replace(/\/$/, "")}/storage/v1/object/public/avatars/${path}`;
}
