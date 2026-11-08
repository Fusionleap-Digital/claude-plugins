# site-ops

Day-to-day operations for a small production website: Next.js (or any
framework) on AWS Amplify, Vercel or Netlify. Six skills, each a set of
plain Node scripts that decide pass or fail, plus checklists for the parts a
script can't see. Claude runs the scripts, reads the reports and drafts the
fixes.

Every check comes from something that went wrong on fusionleap.io or
wysleap.com: an SPF record created at a subdomain literally named `@`, a
DKIM key pasted at the domain root, a contact form still sending through the
old mail provider, env vars that Amplify only reads at build time, and, in
October 2026, "AI crawlers" that turned out to be ten cloud servers rotating
crawler names and asking for `.env` files.

| Skill | Script | What it does |
|---|---|---|
| email-deliverability | `email-dns.mjs` | SPF, DKIM (35 common selectors plus `--selector`), DMARC and MX. Flags multiple SPF records, a record at `\100.<domain>` (the literal `@`), DKIM at the root, no DMARC, an SMTP host from a different provider than MX and SPF. Checklist for the contact form's sending path |
| deploy-check | `env-check.mjs`, `smoke.mjs` | Before: every `process.env` the code reads is set in the host (names only, never values), Amplify vars the build doesn't write to `.env`, `NEXT_PUBLIC_` secrets, `npm run build`. After: key routes, expected text, security headers present, forms render, sitemap and robots, 404s; compare with a baseline. Rollback steps per host |
| bot-triage | `bot-verify.mjs` | Reads an access log (Amplify, CloudFront, nginx/Apache, JSON lines, CSV) and checks each claimed crawler (Googlebot, Bingbot, GPTBot, ClaudeBot, PerplexityBot, CCBot, Applebot, Amazonbot, Bytespider, …) against the owner's published IP ranges and reverse-then-forward DNS. Reports fakes, the networks they came from, name rotation, and what they asked for |
| ai-visibility | `ai-visibility.mjs` | robots.txt verdict per AI crawler, llms.txt, Organization and WebSite JSON-LD, `disambiguatingDescription`, meta tags. Checklist for asking the assistants about the company and comparing their answers with the site |
| lead-flow-test | `lead-test.mjs` | Dry run by default: finds the form, its fields and its endpoint (even for forms posted by JavaScript) and builds a clearly marked test lead. `--submit` sends exactly one, only on a site that proves ownership. Checklist for following it to the database, inbox and admin view, and cleaning up |
| ops-digest | `digest.mjs` | One weekly report: uptime, TLS and domain expiry (RDAP), security headers (or the site-hardening probe's report), the checks above, `npm audit`, optional Lighthouse, and an analytics extension point. How to schedule it as a Claude Code routine |

### Safety

- **Your own sites only.** The lead test, the one script that writes, won't
  submit to a public host until it finds `site-ops-verification=<any-id>`
  in `https://<site>/.well-known/site-ops.txt` or a DNS TXT record on
  `_site-ops.<site>` (the site-hardening proof also works). Local hosts
  need none.
- **Read-only by default.** GET requests at 2 per second (5 max), DNS
  lookups, one TLS handshake, one SMTP EHLO/QUIT. Bot triage reads the log
  and sends nothing to your site.
- **No secrets in reports.** The env check reads names, never values; the
  lead test records the response's JSON keys, not its contents.

### Install

```
/plugin marketplace add Fusionleap-Digital/claude-plugins
/plugin install site-ops@fusionleap
```

Then ask Claude things like "check my domain's email setup", "is the site OK
after the deploy?", "are these GPTBot hits real?" (with a log file), "how do
AI assistants see us?", "test the contact form", or "set up a weekly ops
report".

### Run the scripts directly

Node 18+, no dependencies. Each writes `report.md` and `report.json` to a
`site-ops-<check>-<name>-<date>/` folder (or `--out`). Exit code 1 means a
critical or high finding, so they can run in CI.

```bash
node plugins/site-ops/skills/email-deliverability/scripts/email-dns.mjs example.com --smtp-host smtp.gmail.com
```

```bash
node plugins/site-ops/skills/deploy-check/scripts/env-check.mjs ./my-site --amplify-app <app-id> --branch main --build
```

```bash
node plugins/site-ops/skills/deploy-check/scripts/smoke.mjs https://example.com --form /contact --expect "/::Welcome"
```

```bash
node plugins/site-ops/skills/bot-triage/scripts/bot-verify.mjs access-log.csv
```

```bash
node plugins/site-ops/skills/ai-visibility/scripts/ai-visibility.mjs https://example.com --name "Example Co"
```

```bash
node plugins/site-ops/skills/lead-flow-test/scripts/lead-test.mjs https://example.com --page /contact
```

```bash
node plugins/site-ops/skills/ops-digest/scripts/digest.mjs https://example.com --repo ./my-site --lighthouse
```

`--help` on any script lists its flags.

### Analytics

The digest takes `--analytics ./module.mjs`: a module whose default export
gets `{ site, since, until }` and returns `{ title, summary, metrics,
findings }`. `skills/ops-digest/scripts/analytics-example.mjs` is the
template. A WysLeap module will plug in here once WysLeap API access is
available.

### Test

```bash
node --test test/site-ops.test.mjs
```

Offline: DNS is faked, crawler IP lists come from
`test/site-ops-fixtures/ranges/`, and the HTTP checks run against a local
fixture site with deliberate problems (`test/site-ops-fixture-server.mjs`,
port 4596: blocked AI search bot, broken JSON-LD, a sitemap URL on an
`amplifyapp.com` host, a 500 page, a noindex page, missing CSP and
Referrer-Policy, a JavaScript-posted contact form with a honeypot field).
13 tests, including that a value from the host env list never reaches a
report and that the lead test refuses an unverified public host.
