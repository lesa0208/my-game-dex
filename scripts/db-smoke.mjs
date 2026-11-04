/**
 * Integration checks against the running local Supabase stack, through its real
 * API. Complements the pgTAP suite, which can't see objects it creates inside a
 * transaction from another connection.
 *
 * Checks that new objects aren't exposed through the API, and that platform
 * services still work after the migrations. Prints statuses only, never keys.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const cli = join(root, "node_modules", "supabase", "dist", "supabase.js");
const projectId = /project_id\s*=\s*"([^"]+)"/.exec(readFileSync(join(root, "supabase", "config.toml"), "utf8"))[1];
const dbContainer = `supabase_db_${projectId}`;

let passed = 0;
let failed = 0;
function check(name, ok, detail = "") {
  if (ok) passed += 1;
  else failed += 1;
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${!ok && detail ? ` (${detail})` : ""}`);
}

function psql(sql) {
  return execFileSync("docker", ["exec", "-i", dbContainer, "psql", "-U", "postgres", "-d", "postgres", "-X", "-q", "-v", "ON_ERROR_STOP=1", "-At"], {
    input: sql,
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
  }).trim();
}

const status = JSON.parse(execFileSync(process.execPath, [cli, "status", "-o", "json"], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }));
const api = status.API_URL;
const anonKey = status.ANON_KEY ?? status.PUBLISHABLE_KEY;
const serviceKey = status.SERVICE_ROLE_KEY ?? status.SECRET_KEY;
if (!api || !anonKey || !serviceKey) {
  console.error("Couldn't read the local stack's status. Is it running? Try npm run db:start.");
  process.exit(1);
}

const anon = { apikey: anonKey, Authorization: `Bearer ${anonKey}`, "Content-Type": "application/json" };
const service = { apikey: serviceKey, Authorization: `Bearer ${serviceKey}`, "Content-Type": "application/json" };

async function exposureChecks() {
  console.log("\nNew objects through the API");
  try {
    psql(`create table public.__smoke_t (id int primary key, secret text);
          insert into public.__smoke_t values (1, 'marker');
          create function public.__smoke_f() returns text language sql set search_path = '' as $$ select 'ran' $$;
          notify pgrst, 'reload schema';`);
    await new Promise((resolve) => setTimeout(resolve, 2500));

    let response = await fetch(`${api}/rest/v1/__smoke_t?select=*`, { headers: anon });
    let body = await response.text();
    check("anon can't read a new table", !response.ok && !body.includes("marker"), `status ${response.status}`);

    response = await fetch(`${api}/rest/v1/__smoke_t`, { method: "POST", headers: anon, body: JSON.stringify({ id: 2, secret: "x" }) });
    check("anon can't insert into a new table", !response.ok, `status ${response.status}`);

    response = await fetch(`${api}/rest/v1/__smoke_t?id=eq.1`, { method: "DELETE", headers: anon });
    check("anon can't delete from a new table", !response.ok, `status ${response.status}`);

    response = await fetch(`${api}/rest/v1/rpc/__smoke_f`, { method: "POST", headers: anon, body: "{}" });
    body = await response.text();
    check("anon can't run a new function", !response.ok && !body.includes("ran"), `status ${response.status}`);

    response = await fetch(`${api}/rest/v1/__smoke_t?select=*`, { headers: service });
    body = await response.text();
    check("service_role can't read a new table without a grant", !response.ok && !body.includes("marker"), `status ${response.status}`);

    check("the anon attempts changed nothing", psql("select count(*) from public.__smoke_t;") === "1");
  } finally {
    psql(`drop function if exists public.__smoke_f(); drop table if exists public.__smoke_t; notify pgrst, 'reload schema';`);
  }

  const response = await fetch(`${api}/rest/v1/`, { headers: { ...anon, "Accept-Profile": "private" } });
  const body = await response.text();
  check("the private schema isn't exposed through the API", response.status === 406 && body.includes("PGRST106"), `status ${response.status}`);
}

async function platformChecks() {
  console.log("\nPlatform services");
  let response = await fetch(`${api}/auth/v1/health`, { headers: { apikey: anonKey } });
  check("auth health", response.ok, `status ${response.status}`);

  const email = `smoke-${randomUUID()}@example.test`;
  const password = randomUUID();
  let userId;
  try {
    response = await fetch(`${api}/auth/v1/signup`, { method: "POST", headers: anon, body: JSON.stringify({ email, password }) });
    const session = await response.json();
    userId = session.user?.id ?? session.id;
    check("auth can sign up a user", response.ok && !!session.access_token, `status ${response.status}`);

    const asUser = { apikey: anonKey, Authorization: `Bearer ${session.access_token}`, "Content-Type": "application/json" };
    response = await fetch(`${api}/auth/v1/user`, { headers: asUser });
    check("auth can read the signed-in user", response.ok, `status ${response.status}`);

    response = await fetch(`${api}/rest/v1/`, { headers: service });
    check("the REST API responds", response.ok, `status ${response.status}`);

    response = await fetch(`${api}/storage/v1/bucket`, { headers: service });
    check("storage can list buckets", response.ok, `status ${response.status}`);

    response = await fetch(`${api}/storage/v1/bucket`, { headers: asUser });
    check("storage accepts a user session", response.ok, `status ${response.status}`);

    const joined = await new Promise((resolve) => {
      const socket = new WebSocket(`${api.replace(/^http/, "ws")}/realtime/v1/websocket?apikey=${anonKey}&vsn=1.0.0`);
      const timer = setTimeout(() => { socket.close(); resolve(false); }, 8000);
      socket.onopen = () => socket.send(JSON.stringify({ topic: "realtime:smoke", event: "phx_join", payload: {}, ref: "1" }));
      socket.onmessage = (event) => {
        const message = JSON.parse(event.data);
        if (message.ref === "1") { clearTimeout(timer); socket.close(); resolve(message.payload?.status === "ok"); }
      };
      socket.onerror = () => { clearTimeout(timer); resolve(false); };
    });
    check("realtime accepts a channel join", joined);
  } finally {
    if (userId) {
      response = await fetch(`${api}/auth/v1/admin/users/${userId}`, { method: "DELETE", headers: service });
      check("auth can delete the test user", response.ok, `status ${response.status}`);
    }
  }
}

try {
  await exposureChecks();
  await platformChecks();
} catch (error) {
  failed += 1;
  console.error(`FAIL smoke test stopped early: ${error.message}`);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
