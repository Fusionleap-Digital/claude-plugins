---
name: deploy-check
description: Check a website deploy before and after it ships. Before, confirm every environment variable the code reads is set in the host (AWS Amplify, Vercel, Netlify) and the build passes; after, smoke-test key routes, expected text, security headers, forms, sitemap and robots, and know how to roll back. Use when the user is about to deploy or just deployed, asks "is the site OK after the deploy", sees a broken page or empty env var in production, changed env vars, or wants a deploy checklist or rollback steps for Amplify, Vercel or Netlify.
---

# Deploy check

Three parts:

1. **Before the deploy**: env vars (`scripts/env-check.mjs`) and the build.
2. **After the deploy**: smoke test (`scripts/smoke.mjs`).
3. **If it's broken**: roll back (`references/hosts.md`).

## Rules

- **The user's own sites and repos only.**
- **Names, never values.** `env-check.mjs` reads env var names from the
  code, local `.env` files and the host. It drops values as soon as it
  reads a line, and never prints them. Don't print them either: no
  `cat .env`, no `aws amplify get-app` without a `--query` that keeps only
  the keys.
- **Read-only.** The smoke test sends GET requests only, 2 per second by
  default (5 max). The env check runs read-only host CLI commands.
- **Ask before deploying, redeploying, rolling back or changing env vars.**
  Say exactly what you'll run and on which branch.

## 1. Before the deploy

```bash
node "${CLAUDE_PLUGIN_ROOT}/skills/deploy-check/scripts/env-check.mjs" . --amplify-app <app-id> --branch main --build
```

- Host: `--amplify-app <id>` (find it with `aws amplify list-apps --query 'apps[].[name,appId]'`),
  `--host vercel` (needs the `vercel` CLI, linked), `--host netlify` (needs
  the `netlify` CLI, linked), or `--names-file names.txt` with one name per
  line that the user copied from the console.
- `--build` runs `npm run build` and records pass or fail.
- Exit code 1 means a critical or high finding.

| Check | Fails when |
|---|---|
| env-missing-in-host | The code reads a variable the host doesn't set (medium if the code has a fallback, since the fallback may be wrong for production, e.g. an old mail host) |
| amplify-env-not-in-dotenv | Amplify SSR: the var is set in the console, but `amplify.yml` doesn't write it to `.env`, so server code sees it empty |
| public-secret | A `NEXT_PUBLIC_` variable looks like a secret; it ends up in the browser bundle |
| env-undocumented | Read by the code but missing from `.env.example` |
| env-unused-in-host (info) | Set in the host, read by nothing: often a leftover from a provider move |
| amplify-redeploy-needed (info) | The build bakes env vars into `.env`, so a console change needs a new build |
| build-failed | `npm run build` failed |

Also check before deploying, by hand:

- `git status` is clean and the branch is the one the host deploys.
- Database migrations, if any, are safe to run before the new code (or are
  run as part of the deploy).
- If env vars changed, they're changed in the host **before** the build
  starts (Amplify bakes them in at build time).

## 2. After the deploy

Take a baseline first if you can (before the deploy finishes, or from the
last good run), then compare:

```bash
node "${CLAUDE_PLUGIN_ROOT}/skills/deploy-check/scripts/smoke.mjs" https://example.com --form /contact --expect "/::Book a call" --baseline site-ops-smoke-example.com-<date>/report.json
```

- Always checks `/`, `robots.txt`, the sitemap, up to 8 sitemap pages
  (`--sitemap-pages`), and that a missing page returns 404.
- `--route /a,/b` adds routes; `--expect "/path::text"` (repeatable) checks a
  page contains that text; `--form /contact` checks that page has a form
  with a submit button.
- `--baseline` compares with an earlier report and flags routes whose
  status changed and headers that disappeared.

| Check | Fails when |
|---|---|
| route-status | A route doesn't return 200 (critical for `/`) |
| route-error-page | 200, but the page shows a Next.js application error or error title |
| route-noindex | A sitemap page has `noindex` (a staging setting that shipped) |
| robots-blocks-all | `User-agent: *` / `Disallow: /` in production |
| sitemap-wrong-host | Sitemap URLs point at another host, usually a preview or `amplifyapp.com` domain from a wrong site URL env var |
| security-headers / header-lost | HSTS, CSP, nosniff, framing or Referrer-Policy is missing on `/` (full header review: the site-hardening plugin's probe) |
| form-missing | The page given with `--form` has no `<form>` in its HTML |
| not-found-crash / soft-404 | The not-found page errors, or missing pages return 200 |

The smoke test reads server HTML. A form drawn only in the browser, or a
page behind sign-in, needs a look in a browser. To test that a form
actually delivers, use the lead-flow-test skill.

## 3. Roll back

`references/hosts.md` has, for each host, where env vars live, how a change
takes effect, and the rollback steps. Ask before running any of them. After
a rollback, run the smoke test again.

## Report

Before: list missing or broken env vars first (these break production
silently), then build result. After: routes that fail, then lost headers or
robots/sitemap problems, then the rest. Say what wasn't checked (signed-in
pages, browser-only forms) and whether a rollback is advised.
