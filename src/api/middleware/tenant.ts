import type { FastifyRequest } from "fastify";

import { AppError } from "../errors.js";
import { isOwnerLookupSkipped } from "./auth.js";

// BUG FOUND 2026-09-16: this hook had its OWN exemption list — just
// "/health" — separate from globalAuthenticationHook's `isOwnerLookupSkipped`
// in auth.ts, which also exempts "/", "/index.html", "/favicon.ico",
// "/manifest.json", "/robots.txt" and "/assets/*". globalAuthenticationHook
// runs first and correctly skips setting `request.terminal` for those paths
// — but this hook ran right after it, saw no terminal, and threw anyway.
//
// Net effect: the till's OWN login/pairing page could never load, for
// anyone, token or not. A brand-new terminal had no way to reach the screen
// that asks for its token in the first place. Caught while trying to run a
// sale through the till UI with a real terminal token — the token was
// valid (proven against an authenticated API route) and the page was still
// unreachable, which is what pointed here.
//
// FIXED by sharing the ONE exemption list instead of each hook keeping its
// own — two independently-maintained copies of "which paths skip auth" is
// exactly the shape of drift that caused this.
export const resolveTenantHook = async (request: FastifyRequest): Promise<void> => {
  if (request.server.authDisabled || isOwnerLookupSkipped(request.method, request.url)) return;
  if (!request.terminal?.tenantId) throw new AppError(401, "Terminal not authorised");
  request.tenantId = request.terminal.tenantId;
};
