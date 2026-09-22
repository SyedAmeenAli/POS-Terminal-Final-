# pos-web — the till UI served as static files, separate from this service's API.
#
# WHY A SEPARATE SERVICE. The main Dockerfile bakes web/dist into the
# pos-terminal image, but that service's auth guard covers "/", so the bundle
# it carries answers 401 and is unreachable. pos-web exists to serve it
# unauthenticated. Do not delete it assuming pos-terminal already serves the app.
#
# WHY THIS FILE IS COMMITTED. It was not, until now. The July deploy that put
# pos-web live was built from a hand-made Dockerfile and nginx.conf that existed
# only on one machine and were uploaded straight to Cloud Build. Every later
# `gcloud run deploy pos-web --source web` therefore found no Dockerfile, fell
# back to buildpacks, produced a container with no start command, and failed the
# startup probe. Cloud Run kept traffic on the old revision, so the deploy
# reported failure but the site stayed up serving July's bundle — and the
# failure was easy to miss. Two deploys were lost that way.
#
# BUILD THE BUNDLE FIRST. This image only copies dist/; it does not run vite.
# The API base is baked in at build time, so:
#
#   VITE_API_BASE=https://pos-terminal-902186518684.asia-south2.run.app \
#     pnpm --filter pos-terminal-web build
#   gcloud run deploy pos-web --source web --region=asia-south2
#
# Skip the env var and the bundle falls back to "/api", which on this host is
# nginx serving static files — every API call would 404.
FROM nginx:alpine
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY dist /usr/share/nginx/html

# THE CHECK THAT WOULD HAVE CAUGHT SEPTEMBER'S BROKEN TILL.
#
# scripts/check-pos-web-csp.ts has asserted exactly this since it was written,
# and on 2026-09-11 the till went to production anyway, built without
# VITE_API_BASE: every API call fell back to "/api", which on this host is
# nginx serving index.html, so the shopkeeper's till read "Backend
# unreachable" and every sale would have queued. The check existed. Nothing
# ran it, because `gcloud run deploy --source web` uploads dist/ straight to
# Cloud Build and never touches package.json scripts.
#
# So the check lives HERE too, in the one place every deploy must pass
# through — a lint step can be skipped, an image build cannot.
#
# Two failures, both silent in the browser's network tab because nginx answers
# 200 with HTML for anything it cannot route:
#   1. no origin baked in at all  -> the /api fallback
#   2. an origin CSP forbids      -> connect-src blocks it at the browser
RUN set -eu; \
    origins="$(grep -rhoE 'https://[a-z0-9-]+\.[a-z0-9.-]*run\.app' /usr/share/nginx/html/assets/ | sort -u)"; \
    if [ -z "$origins" ]; then \
      echo "FAIL: the bundle has no API origin baked in — built without VITE_API_BASE," >&2; \
      echo "      so every call goes to /api, which this nginx answers with index.html." >&2; \
      echo "      Rebuild: VITE_API_BASE=https://pos-terminal-902186518684.asia-south2.run.app pnpm --filter pos-terminal-web build" >&2; \
      exit 1; \
    fi; \
    csp="$(grep -F 'connect-src' /etc/nginx/conf.d/default.conf)"; \
    for origin in $origins; do \
      case "$csp" in \
        *"$origin"*) ;; \
        *) echo "FAIL: the bundle calls $origin but nginx connect-src does not allow it." >&2; \
           echo "      Rebuild with a matching VITE_API_BASE, or update web/nginx.conf." >&2; \
           exit 1 ;; \
      esac; \
    done; \
    echo "pos-web bundle OK — calls: $origins"
