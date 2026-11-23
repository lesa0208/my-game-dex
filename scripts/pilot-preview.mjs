/**
 * The M15 pilot preview: this checkout's production build served on http://127.0.0.5:3005 against
 * the SNES pilot stack only, as ~/.my-game-dex/b1-preview.mjs serves B1 on 127.0.0.4:3004.
 *
 *   npm run build && node scripts/pilot-preview.mjs
 *
 * It reads the pilot's URL and keys from `supabase status` (scripts/lib/stack.mjs) and passes them
 * to `next start` as process variables, which take precedence over .env.local (which points at
 * development). It prints no key. It refuses unless the API is the pilot's own port.
 *
 * Its own loopback address, not 127.0.0.1: browsers keep cookies per host, not per port, and the
 * app's auth cookie has the same name on every local stack, so a pilot sign-in on 127.0.0.1 would
 * replace the development (3000) session. The pilot's Auth links point here too (test-stack.mjs).
 * It doesn't touch the development server on port 3000.
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

process.env.MGD_STACK = "pilot";
const { EDITORIAL_STACKS, root, stackStatus } = await import("./lib/stack.mjs");

/** The server-only variable the app reads its Auth admin key from (as in app-harness.mjs). */
const SECRET_KEY_VARIABLE = "SUPABASE_SECRET_KEY";
const target = EDITORIAL_STACKS.pilot;
const status = stackStatus({ label: "the pilot preview", editorial: true });
if (Number(new URL(status.API_URL).port) !== target.apiPort) throw new Error(`Refusing: this is not the pilot stack (API port ${target.apiPort}).`);
if (!existsSync(join(root, ".next", "BUILD_ID"))) throw new Error("Build first: npm run build.");
const origin = new URL(target.preview);

const child = spawn(process.execPath, [join(root, "node_modules", "next", "dist", "bin", "next"), "start", "-p", origin.port, "-H", origin.hostname], {
  cwd: root,
  env: {
    ...process.env,
    NODE_ENV: "production",
    SUPABASE_URL: status.API_URL,
    SUPABASE_PUBLISHABLE_KEY: status.PUBLISHABLE_KEY ?? status.ANON_KEY,
    [SECRET_KEY_VARIABLE]: status.SECRET_KEY ?? status.SERVICE_ROLE_KEY,
    // Never the demo data, whatever .env.local says.
    ENABLE_SEED_DATA: "false",
  },
  stdio: ["ignore", "inherit", "inherit"],
});
console.log(`Pilot preview: ${target.preview} (pilot stack, API port ${target.apiPort})`);
child.on("exit", (code) => process.exit(code ?? 0));
