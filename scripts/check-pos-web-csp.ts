// Does the CSP let the till reach the API it was built to call?
//
// THE FAILURE THIS EXISTS FOR. web/nginx.conf names an origin in connect-src.
// web/dist has a different origin baked into it by VITE_API_BASE. Nothing
// links the two, and if they drift the till loads, renders, looks entirely
// healthy, and every API call is blocked by the browser. The first person to
// find out is a cashier with a customer waiting.
//
// Comparing two sources of truth and refusing when they disagree — the same
// shape as schema-drift-check.ts in the IMS repo.
//
// Run:  ./node_modules/.bin/tsx scripts/check-pos-web-csp.ts
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const WEB = join(import.meta.dirname, "..", "web");
const fail = (message: string): never => {
  console.error(`FAIL: ${message}`);
  process.exit(1);
};

// Comment lines are stripped BEFORE parsing. The first version of this script
// did not, matched the `connect-src 'self'` inside the comment explaining why
// 'self' is wrong here, and reported a failure against prose.
const conf = readFileSync(join(WEB, "nginx.conf"), "utf8")
  .split("\n")
  .filter((line) => !line.trim().startsWith("#"))
  .join("\n");

const csp = /add_header\s+Content-Security-Policy\s+"([^"]+)"/.exec(conf)?.[1];
if (!csp) fail("no Content-Security-Policy add_header found in web/nginx.conf");

const connectSrc = /connect-src ([^;]+)/.exec(csp!)?.[1]?.trim();
if (!connectSrc) fail("the CSP in web/nginx.conf has no connect-src directive");

let assets: string[];
try {
  assets = readdirSync(join(WEB, "dist", "assets")).filter((f) => f.endsWith(".js"));
} catch {
  // Not a failure: the bundle simply has not been built in this checkout.
  // Refusing here would make a fresh clone fail a check it cannot yet answer.
  console.log("web/dist/assets not built — nothing to compare. Build first if you meant to check.");
  process.exit(0);
}

const bundle = assets.map((f) => readFileSync(join(WEB, "dist", "assets", f), "utf8")).join("");
const baked = [...new Set([...bundle.matchAll(/https:\/\/[a-z0-9-]+\.[a-z0-9.-]*run\.app/g)].map((m) => m[0]))];

if (baked.length === 0) {
  // The bundle falls back to "/api" when VITE_API_BASE is unset. On this host
  // /api is nginx serving static files, so every call would 404 — a different
  // failure from the CSP one, and just as invisible until the counter.
  fail("the bundle has no API origin baked in — it was built without VITE_API_BASE, so it will call /api and 404");
}

const missing = baked.filter((origin) => !connectSrc!.includes(origin));
if (missing.length) {
  fail(
    `the bundle calls ${missing.join(", ")} but connect-src does not allow it.\n` +
      `  connect-src: ${connectSrc}\n` +
      `  Rebuild with a matching VITE_API_BASE, or update web/nginx.conf.`,
  );
}

console.log(`PASS — connect-src allows every origin the bundle calls (${baked.join(", ")}).`);
