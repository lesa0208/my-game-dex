/**
 * UUIDv7 (RFC 9562), made by the app for each copy it means to add. The id is the
 * idempotency key for `add_collection_item` (M6b): resending it returns the same copy
 * rather than adding another. The database accepts only a UUIDv7 made within the last
 * 24 hours, so a fresh one is made for every intended copy.
 */

export const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function uuidv7(now: number = Date.now()): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  // The 48-bit millisecond timestamp, big-endian. Exact: milliseconds stay below 2^53.
  for (let i = 0; i < 6; i += 1) bytes[i] = Math.floor(now / 2 ** (8 * (5 - i))) % 256;
  bytes[6] = (bytes[6] & 0x0f) | 0x70;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
