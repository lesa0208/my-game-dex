/**
 * The IGDB API v4 client (M18a), for server-side tools only: never imported by app or browser
 * code. Twitch OAuth client credentials, cached in memory and renewed before they expire or when
 * IGDB answers 401. At most 4 requests started in any second and 8 open at once (IGDB's documented
 * limits; the defaults are lower). Retries 429 (honouring Retry-After), 5xx, timeouts and network
 * failures with back-off; never retries a refused query. Errors never carry a credential or token.
 *
 * Tests inject fetchImpl, now, sleep and random. Another API or token URL is accepted only on a
 * loopback address (a local stand-in), as the Wikidata client's is.
 */

export const IGDB_API_URL = "https://api.igdb.com/v4";
export const TWITCH_TOKEN_URL = "https://id.twitch.tv/oauth2/token";
/** IGDB's documented limits: 4 requests a second, 8 open requests. */
export const IGDB_LIMITS = { perSecond: 4, open: 8 };

export class IgdbError extends Error {
  /** kind: config | auth | forbidden | query | rate | unavailable | http */
  constructor(kind, message, status = null) {
    super(message);
    this.name = "IgdbError";
    this.kind = kind;
    this.status = status;
  }
}

const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);

function checkedUrl(url, fallback, label) {
  if (!url || url === fallback) return fallback;
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new IgdbError("config", `${label} isn't a URL.`);
  }
  if (!LOOPBACK.has(parsed.hostname)) throw new IgdbError("config", `${label} may only be replaced by a local stand-in on a loopback address.`);
  return url.replace(/\/$/, "");
}

const ENDPOINT = /^[a-z_]{1,40}(\/count)?$/;
const RETRY_STATUS = new Set([429, 500, 502, 503, 504]);

/** Quotes a string for an Apicalypse query. */
export function apicalypseString(value) {
  return `"${String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

export function createIgdbClient({
  clientId,
  clientSecret,
  fetchImpl = globalThis.fetch,
  now = () => Date.now(),
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  random = Math.random,
  apiUrl = IGDB_API_URL,
  tokenUrl = TWITCH_TOKEN_URL,
  perSecond = 3,
  maxOpen = 4,
  timeoutMs = 15000,
  maxAttempts = 5,
  backoffMs = [1000, 2000, 4000, 8000],
} = {}) {
  if (!clientId || !clientSecret) throw new IgdbError("config", "IGDB credentials aren't configured. Run: node scripts/igdb.mjs check");
  if (!(perSecond >= 1 && perSecond <= IGDB_LIMITS.perSecond)) throw new IgdbError("config", `perSecond must be 1 to ${IGDB_LIMITS.perSecond}.`);
  if (!(maxOpen >= 1 && maxOpen <= IGDB_LIMITS.open)) throw new IgdbError("config", `maxOpen must be 1 to ${IGDB_LIMITS.open}.`);
  const api = checkedUrl(apiUrl, IGDB_API_URL, "The IGDB API URL");
  const tokenEndpoint = checkedUrl(tokenUrl, TWITCH_TOKEN_URL, "The Twitch token URL");

  const stats = { requests: 0, tokenRequests: 0, retries: 0, statuses: {}, maxOpenSeen: 0, maxPerSecondSeen: 0 };
  let token = null; // { value, expiresAt }
  let tokenPromise = null;

  // ---- limits ----------------------------------------------------------------
  const starts = []; // request start times, for the per-second window
  let gate = Promise.resolve();
  let open = 0;
  const waiting = [];

  /** Waits until another request may start in this second; serialised, so no two callers race. */
  function rateSlot() {
    const next = gate.then(async () => {
      for (;;) {
        const t = now();
        while (starts.length && t - starts[0] >= 1000) starts.shift();
        if (starts.length < perSecond) {
          starts.push(t);
          stats.maxPerSecondSeen = Math.max(stats.maxPerSecondSeen, starts.length);
          return;
        }
        await sleep(Math.max(1, 1000 - (t - starts[0])));
      }
    });
    gate = next.catch(() => {});
    return next;
  }

  async function openSlot() {
    if (open >= maxOpen) await new Promise((resolve) => waiting.push(resolve));
    open += 1;
    stats.maxOpenSeen = Math.max(stats.maxOpenSeen, open);
  }
  function release() {
    open -= 1;
    const next = waiting.shift();
    if (next) next();
  }

  function backoff(attempt, retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds >= 0 && seconds <= 120) return seconds * 1000;
    const base = backoffMs[Math.min(attempt - 1, backoffMs.length - 1)] ?? 8000;
    return base + Math.floor(random() * 250);
  }

  async function timed(url, init) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await fetchImpl(url, { ...init, signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
  }

  // ---- the token ---------------------------------------------------------------
  async function requestToken() {
    // The credentials go in the form body, not the URL, so no proxy or log keeps them.
    const body = new URLSearchParams({ client_id: clientId, client_secret: clientSecret, grant_type: "client_credentials" });
    for (let attempt = 1; ; attempt++) {
      let response;
      try {
        await rateSlot();
        stats.tokenRequests += 1;
        response = await timed(tokenEndpoint, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" }, body });
      } catch {
        if (attempt >= maxAttempts) throw new IgdbError("unavailable", "Twitch's token service didn't answer.");
        stats.retries += 1;
        await sleep(backoff(attempt));
        continue;
      }
      if (response.ok) {
        const data = await response.json().catch(() => null);
        if (!data?.access_token || !Number.isFinite(Number(data.expires_in))) throw new IgdbError("auth", "Twitch's token answer had no token.");
        return { value: data.access_token, expiresAt: now() + Number(data.expires_in) * 1000 };
      }
      if ([400, 401, 403].includes(response.status)) {
        throw new IgdbError("auth", `Twitch refused the client credentials (HTTP ${response.status}). Check IGDB_CLIENT_ID and IGDB_CLIENT_SECRET.`, response.status);
      }
      if (RETRY_STATUS.has(response.status) && attempt < maxAttempts) {
        stats.retries += 1;
        await sleep(backoff(attempt, response.headers?.get?.("retry-after")));
        continue;
      }
      throw new IgdbError("unavailable", `Twitch's token service answered HTTP ${response.status}.`, response.status);
    }
  }

  /** The cached token, renewed a minute before it expires; one request at a time. */
  async function accessToken(force = false) {
    if (!force && token && now() < token.expiresAt - 60_000) return token.value;
    if (!tokenPromise) {
      tokenPromise = requestToken().then(
        (t) => {
          token = t;
          tokenPromise = null;
          return t.value;
        },
        (error) => {
          tokenPromise = null;
          throw error;
        },
      );
    }
    return tokenPromise;
  }

  // ---- queries -----------------------------------------------------------------
  /** POST an Apicalypse query to an endpoint ("games", "platforms", "games/count"). */
  async function query(endpoint, body) {
    if (!ENDPOINT.test(endpoint)) throw new IgdbError("config", "Unknown IGDB endpoint.");
    if (typeof body !== "string" || body.length > 20000) throw new IgdbError("config", "An IGDB query is a string under 20,000 characters.");
    let renewed = false;
    for (let attempt = 1; ; attempt++) {
      const bearer = await accessToken();
      await openSlot();
      let response;
      try {
        await rateSlot();
        stats.requests += 1;
        response = await timed(`${api}/${endpoint}`, {
          method: "POST",
          headers: { "Client-ID": clientId, Authorization: `Bearer ${bearer}`, Accept: "application/json", "Content-Type": "text/plain" },
          body,
        });
      } catch {
        release();
        if (attempt >= maxAttempts) throw new IgdbError("unavailable", `IGDB didn't answer (${endpoint}), after ${attempt} attempts.`);
        stats.retries += 1;
        await sleep(backoff(attempt));
        continue;
      }
      release();
      stats.statuses[response.status] = (stats.statuses[response.status] ?? 0) + 1;
      if (response.ok) return response.json();
      if (response.status === 401 && !renewed) {
        // The token expired or was revoked: one fresh token, then the same query again.
        renewed = true;
        token = null;
        await accessToken(true);
        attempt -= 1;
        continue;
      }
      if (response.status === 401) throw new IgdbError("auth", "IGDB refused the token, even a fresh one. Check the Twitch application.", 401);
      if (response.status === 403) throw new IgdbError("forbidden", "IGDB refused the request (HTTP 403).", 403);
      if (response.status === 400) {
        const detail = (await response.text().catch(() => "")).slice(0, 300);
        throw new IgdbError("query", `IGDB refused the query (${endpoint}): ${detail}`, 400);
      }
      if (RETRY_STATUS.has(response.status) && attempt < maxAttempts) {
        stats.retries += 1;
        await sleep(backoff(attempt, response.headers?.get?.("retry-after")));
        continue;
      }
      throw new IgdbError(response.status === 429 ? "rate" : RETRY_STATUS.has(response.status) ? "unavailable" : "http", `IGDB answered HTTP ${response.status} (${endpoint}).`, response.status);
    }
  }

  return { query, accessToken, stats, limits: { perSecond, maxOpen } };
}
