/**
 * M16: the demo preview. This checkout's production build served on http://127.0.0.6:3006 against
 * the demo stack only (MGD_STACK=demo), as the pilot preview serves the pilot on 127.0.0.5:3005.
 *
 *   node scripts/demo-preview.mjs   (npm run demo:preview)
 *
 * It builds the app into its own folder (.next-demo, never .next or .next-pilot) with the demo's URL
 * and keys and the demo banner, scans its browser bundles for secrets, then serves that build. It
 * reads the demo's URL and keys from `supabase status` (scripts/lib/stack.mjs), prints no key, and
 * refuses unless the API is the demo's own port. Its own loopback address keeps its sign-in cookie
 * apart from development (3000) and the pilot (127.0.0.5). Auth's links point here (test-stack.mjs).
 */
import { spawn } from "node:child_process";
import { join } from "node:path";

process.env.MGD_STACK = "demo";
const { projectId, root, stackStatus } = await import("./lib/stack.mjs");

const ORIGIN = new URL("http://127.0.0.6:3006");
const DEMO_API_PORT = 54321 + 5000;
/** The server-only variable the app reads its Auth admin key from (as in app-harness.mjs). */
const SECRET_KEY_VARIABLE = "SUPABASE_SECRET_KEY";

if (projectId !== "my-game-dex-demo") throw new Error(`Refusing: the stack's config names "${projectId}", not my-game-dex-demo.`);
const status = stackStatus({ label: "the demo preview" });
if (Number(new URL(status.API_URL).port) !== DEMO_API_PORT) throw new Error(`Refusing: this is not the demo stack (API port ${DEMO_API_PORT}).`);
const next = join(root, "node_modules", "next", "dist", "bin", "next");
const env = {
  ...process.env,
  NODE_ENV: "production",
  SUPABASE_URL: status.API_URL,
  SUPABASE_PUBLISHABLE_KEY: status.PUBLISHABLE_KEY ?? status.ANON_KEY,
  [SECRET_KEY_VARIABLE]: status.SECRET_KEY ?? status.SERVICE_ROLE_KEY,
  ENABLE_SEED_DATA: "false",
  // The banner: "Demo catalog … Not the real catalog." Set at build time, in this build only.
  NEXT_PUBLIC_MGD_DEMO_CATALOG: "1",
  // M18a: IGDB covers and screenshots may be shown here (the demo database records whether they are cleared).
  MGD_PROVIDER_MEDIA: "igdb",
  // Self-registration (features/auth/registration.ts): open on this server only, a server-side
  // variable the browser never sees. The demo stack's Auth allows sign-up and sends the
  // confirmation email to its Mailpit (scripts/test-stack.mjs).
  MGD_SELF_REGISTRATION: "open",
  MGD_NEXT_DIST_DIR: ".next-demo",
};

console.log("Building the app for the demo preview…");
const built = await new Promise((resolve) => spawn(process.execPath, [next, "build"], { cwd: root, env, stdio: ["ignore", "inherit", "inherit"] }).on("exit", resolve));
if (built !== 0) throw new Error(`The demo build failed (exit ${built}). Nothing was served.`);
const scanned = await new Promise((resolve) => spawn(process.execPath, [join(root, "scripts", "check-secrets.mjs"), "--bundle"], { cwd: root, env, stdio: ["ignore", "inherit", "inherit"] }).on("exit", resolve));
if (scanned !== 0) throw new Error("The demo build's browser bundles failed the secret scan. Nothing was served.");
const child = spawn(process.execPath, [next, "start", "-p", ORIGIN.port, "-H", ORIGIN.hostname], { cwd: root, env, stdio: ["ignore", "inherit", "inherit"] });
console.log(`Demo preview: ${ORIGIN.origin} (demo stack, API port ${DEMO_API_PORT})`);
child.on("exit", (code) => process.exit(code ?? 0));
