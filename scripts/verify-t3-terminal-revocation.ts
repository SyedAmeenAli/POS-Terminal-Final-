// End-to-end terminal revocation, in ONE POS process so the auth cache is
// genuinely exercised: authenticate (populating the cache), disable the
// terminal from outside via IMS's real PATCH /terminals/:id route, then poll
// until POS rejects. A fresh process would start with an empty cache and
// prove nothing about the TTL.
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { buildServer } from "../src/api/server.js";
import { loadEnvSync } from "../src/env-sync.js";
import { closePool } from "../src/infrastructure/database/db.js";

const run = promisify(execFile);
const token = process.env.MINT_TOKEN!;
const terminalId = process.env.MINT_TERMINAL!;
const tenantId = process.env.MINT_TENANT!;
const results: { name: string; pass: boolean; detail?: string }[] = [];
const check = (n: string, p: boolean, d?: string) => results.push({ name: n, pass: p, detail: d });
const app = buildServer({ requestTransactions: true });
const headers = { authorization: `Bearer ${token}` };
const ttl = loadEnvSync().TERMINAL_AUTH_CACHE_TTL_SECONDS;

try {
  const before = await app.inject({ headers, method: "GET", url: "/products?limit=1&offset=0" });
  check("newly minted token authenticates on POS", before.statusCode === 200, `got ${before.statusCode}`);

  // Warm the cache deliberately, so revocation has to wait it out.
  await app.inject({ headers, method: "GET", url: "/products?limit=1&offset=0" });

  await run("pnpm", ["exec", "tsx", "scripts/_disable_via_route.ts"], {
    cwd: "/Users/shaikmoosakalam/Desktop/ims - 1 ",
    env: { ...process.env, MINT_TENANT: tenantId, MINT_TERMINAL: terminalId },
  });

  const started = Date.now();
  let status = 200;
  const budgetMs = (ttl + 8) * 1000;
  while (Date.now() - started < budgetMs) {
    const r = await app.inject({ headers, method: "GET", url: "/products?limit=1&offset=0" });
    status = r.statusCode;
    if (status === 401) break;
    await new Promise((res) => setTimeout(res, 250));
  }
  const elapsed = (Date.now() - started) / 1000;

  check(`disabled terminal is rejected within ~${ttl}s`, status === 401, `took ${elapsed.toFixed(1)}s, status ${status}`);
  check("revocation waits out the cache rather than being instant (UI must say so)", elapsed > 0.5, `${elapsed.toFixed(1)}s`);
  check("revocation lands within the advertised TTL budget", elapsed <= ttl + 5, `${elapsed.toFixed(1)}s vs ${ttl}s`);
} finally {
  console.log("\n=== POS TERMINAL REVOCATION (single process, real cache) ===");
  for (const x of results) console.log(`${x.pass ? "PASS" : "FAIL"}  ${x.name}${x.detail ? `  (${x.detail})` : ""}`);
  const failed = results.filter((x) => !x.pass).length;
  console.log(`\n${results.length - failed}/${results.length} passed`);
  if (failed) process.exitCode = 1;
  await app.close();
  await closePool();
}
