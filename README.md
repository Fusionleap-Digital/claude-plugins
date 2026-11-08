# FusionLeap plugins for Claude Code

## site-hardening

Checks a website you own for the files and routes that scanners ask for, then
helps fix what it finds. Built from real traffic: in Oct–Nov 2026, scanners
posing as AI crawlers (CCBot, ClaudeBot, Bytespider, Amazonbot, cohere-ai)
requested `.env` files, cloud keys, and Amplify, Supabase and Terraform config
on our sites. The probe list is those paths plus common secret files.

Four parts:

1. **Live probe** (`scripts/probe.mjs`): ~180 secret/config paths, public
   source maps, encoded-slash auth bypasses (`/%2Fadmin`), path traversal,
   security headers, HTTP→HTTPS redirect.
2. **CSP builder** (`scripts/csp.mjs`): opens the site in headless Chrome,
   records every origin each page loads from, writes a
   Content-Security-Policy, then reloads the pages with it applied
   (report-only) and adds anything still blocked until nothing is. Outputs
   config for Next.js, Amplify, Vercel and Netlify.
3. **Repo audit**: committed secrets, files in `public/`, `NEXT_PUBLIC_`
   secrets, middleware path matching, unauthenticated API routes.
4. **Hosting audit**: AWS Amplify, Vercel, Netlify, Cloudflare settings.

### Safety

- **Ownership required.** The probe won't scan a public host until it finds
  `site-hardening-verification=<any-id>` in
  `https://<site>/.well-known/site-hardening.txt` or a DNS TXT record on
  `_site-hardening.<site>`. Local hosts (`localhost`, `*.test`) are allowed,
  so you can check a production build before deploying.
- **Read-only.** GET requests only, 2 per second by default (5 max).
- **No secrets in reports.** Findings name the kind of secret found, never
  its value.

### Install

```
/plugin marketplace add Fusionleap-Digital/claude-plugins
/plugin install site-hardening@fusionleap
```

Then ask Claude to "harden my website" or "check my site for exposed files".

### Run the probe directly

```bash
node plugins/site-hardening/skills/site-hardening/scripts/probe.mjs https://your-site.com --protected /admin,/dashboard
```

Node 18+, no dependencies. Writes `report.md` and `report.json`. Exit code 1
means a critical or high finding, so it can run in CI after a deploy.

### Build a CSP

```bash
node plugins/site-hardening/skills/site-hardening/scripts/csp.mjs https://your-site.com --pages 12
```

Needs Node 22+ and an installed Chrome, Chromium, Edge or Brave (or
`CHROME_PATH`). `--verify "<policy>"` checks an existing policy instead.

### Test

```bash
node test/vulnerable-server.mjs
```

```bash
node plugins/site-hardening/skills/site-hardening/scripts/probe.mjs http://localhost:4599 --protected /admin
```

The test server leaks on purpose; the probe should report 4 critical and 3
high findings.

```bash
node test/csp-fixture.mjs
```

```bash
node plugins/site-hardening/skills/site-hardening/scripts/csp.mjs http://localhost:4597
```

The CSP fixture has a fixed inline script that calls `eval`, plus a third
party script, image, fetch and iframe. Expected: a `sha256-` hash,
`'unsafe-eval'` added in round 2, and `http://localhost:4598` in script-src,
img-src, connect-src and frame-src.

## License

MIT
