# Hosting checklist

Read and report. Ask the user before changing any setting.

## AWS Amplify

- **What gets deployed.** In `amplify.yml`, `artifacts.baseDirectory` should
  be the build output (`.next` for SSR, `out`/`dist` for static), never the
  repo root. A static site deployed from the root serves every file in it.
- **Rewrites and redirects.** A catch-all `/<*>` → `/index.html` rewrite
  makes every missing path return 200 (a soft 404). It doesn't leak files,
  but it hides real 404s from monitoring.
- **Branch and preview deploys.** Preview and non-production branches
  should have access control (basic auth) on, or not be deployed at all.
  They often run with debug settings.
- **Environment variables.** Secrets belong in Amplify environment variables
  or Secrets Manager, not in `amplify.yml`. Remember `amplify.yml` values
  are visible to anyone with repo access.
- **Custom headers.** Security headers can be set in `customHeaders` in
  `amplify.yml` if the app doesn't set them.
- **WAF (optional).** Amplify supports AWS WAF. The AWS managed "Known bad
  inputs" and "Core rule set" groups block most of these probes at the edge.
  This cuts noise and cost; it does not replace the checks above. WAF has a
  monthly cost, so ask first.
- **Access logs.** Amplify keeps access logs; they show which probe paths
  are being tried and from which IPs.

## Vercel

- Preview deployments are public by default; turn on Deployment Protection.
- Environment variables per environment; check nothing secret is exposed to
  the browser (`NEXT_PUBLIC_`).
- `vercel.json` headers can add security headers.
- Firewall / Attack Challenge Mode is available for spikes.

## Netlify

- Check the publish directory isn't the repo root.
- `_headers` file or `netlify.toml` `[[headers]]` for security headers.
- Deploy previews: set password protection if they show unreleased work.

## Cloudflare (Pages, Workers, or proxy in front)

- `.dev.vars` must never be deployed; it holds local secrets.
- WAF managed rules and "Block AI bots" are separate: the second blocks real
  crawlers, not scanners pretending to be them.
- Transform rules can add security headers.

## DNS and TLS (any host)

- HTTPS only, with HTTP → HTTPS redirect (the probe checks this).
- No forgotten subdomains pointing at deleted resources (subdomain
  takeover). List DNS records and check each CNAME target still exists.
