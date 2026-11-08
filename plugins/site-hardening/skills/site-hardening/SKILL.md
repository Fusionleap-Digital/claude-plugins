---
name: site-hardening
description: Check a website you own for the exposures that scanners look for — leaked .env and key files, cloud and deploy config (Amplify, Supabase, Terraform, Firebase), public source maps, path traversal, encoded-slash auth bypasses and missing security headers — then fix them in the repo and hosting setup. Use when the user asks to harden, secure or audit their website, check for exposed secrets or config files, asks why bots request paths like /.env or /terraform.tfstate, or wants a security check before launch.
---

# Site hardening

Three passes, then one report:

1. **Live probe** of the deployed site (outside view).
2. **Repo audit** of the site's code (inside view).
3. **Hosting audit** of the platform's settings.

Scanners hit every public site with the same list of secret and config paths,
often while pretending to be AI crawlers (CCBot, ClaudeBot, Bytespider,
Amazonbot, cohere-ai). Most of those requests fail. The job here is to prove
they fail and to close the few that don't. Blocking the scanners only cuts
noise; it is not the fix.

## Rules

- **Only scan sites the user owns or has written permission to test.** The
  probe refuses any non-local host until ownership is proven (see below). Do
  not help work around that check, and do not run the probe against a site
  the user hasn't said is theirs.
- **Read-only.** The probe sends GET requests only, at 2 per second by
  default (5 max). Don't write extra requests that post, log in, or try to
  use what was found.
- **Never print secrets.** If a check finds secret material, report which
  file and what kind (the probe only records the signature name). Tell the
  user to rotate it. Don't fetch it again to show its contents.

## 1. Live probe

Ownership check, one of:

- A file at `https://<site>/.well-known/site-hardening.txt` containing
  `site-hardening-verification=<any-id>`
- A DNS TXT record on `_site-hardening.<site>` with that same value

Local hosts (`localhost`, `127.0.0.1`, `*.localhost`, `*.test`) need no proof,
so a production build running locally (`next build && next start`) can be
checked before deploying.

Run:

```bash
node "${CLAUDE_PLUGIN_ROOT}/skills/site-hardening/scripts/probe.mjs" https://example.com --protected /admin,/dashboard
```

- `--protected` lists routes that should need sign-in; the probe checks
  whether `/%2Fadmin`, `//admin` and similar variants get past the guard.
  Ask the user which routes are protected. Defaults: `/admin`, `/dashboard`,
  `/settings`, `/account`, `/api/admin`.
- `--rate` requests per second (default 2, max 5). `--out` report folder.
- Takes about two minutes. Exit code 1 means a critical or high finding.

It writes `report.md` and `report.json`. What it checks:

| Check | Fails when |
|---|---|
| exposed-file | One of ~180 paths in `references/probe-paths.tsv` returns 2xx with content other than the site's normal not-found page. **critical** if the body contains secret material (private key, service account, AWS key, dotenv, git config, process environment) |
| source-map | A production `.js.map` is public (high if it embeds original source) |
| auth-bypass | A guarded route is reachable through an encoded or doubled slash |
| header-* | HSTS, CSP, nosniff, framing protection or Referrer-Policy is missing; `X-Powered-By` or a versioned `Server` header leaks the stack |
| https-redirect | Plain HTTP doesn't redirect to HTTPS |
| recon (review) | `/api/auth/session` or `/api/config` answers signed-out visitors; check by hand what it reveals |

A 5xx on a traversal probe is a warning: the route crashed on bad input,
which is worth reading even when nothing leaked.

## 2. Repo audit

Work through `references/repo-checklist.md` in the site's repo. It has the
commands to run and what a failure looks like, for Next.js first and other
frameworks after.

## 3. Hosting audit

Work through `references/hosting-checklist.md` for the user's platform
(AWS Amplify, Vercel, Netlify, Cloudflare). Ask before changing any hosting
setting; read and report only unless the user says to change it.

## Report

Combine the three passes into one list, most severe first. For each
problem: what's wrong, where (URL or file:line), why it matters in one line,
and the fix. Put "rotate these secrets" at the very top if anything critical
was found. Say what was not checked (for example, routes behind sign-in, or
hosting settings you couldn't see).

After fixes are deployed, run the probe again and show the before and after.
