# FusionLeap plugins for Claude Code

## site-hardening

Checks a website you own for the files and routes that scanners ask for, then
helps fix what it finds. Built from real traffic: in Oct–Nov 2026, scanners
posing as AI crawlers (CCBot, ClaudeBot, Bytespider, Amazonbot, cohere-ai)
requested `.env` files, cloud keys, and Amplify, Supabase and Terraform config
on our sites. The probe list is those paths plus common secret files.

Three passes:

1. **Live probe** (`scripts/probe.mjs`): ~180 secret/config paths, public
   source maps, encoded-slash auth bypasses (`/%2Fadmin`), path traversal,
   security headers, HTTP→HTTPS redirect.
2. **Repo audit**: committed secrets, files in `public/`, `NEXT_PUBLIC_`
   secrets, middleware path matching, unauthenticated API routes.
3. **Hosting audit**: AWS Amplify, Vercel, Netlify, Cloudflare settings.

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
/plugin marketplace add <this-repo-url>
/plugin install site-hardening@fusionleap
```

Then ask Claude to "harden my website" or "check my site for exposed files".

### Run the probe directly

```bash
node plugins/site-hardening/skills/site-hardening/scripts/probe.mjs https://your-site.com --protected /admin,/dashboard
```

Node 18+, no dependencies. Writes `report.md` and `report.json`. Exit code 1
means a critical or high finding, so it can run in CI after a deploy.

### Test

```bash
node test/vulnerable-server.mjs
```

```bash
node plugins/site-hardening/skills/site-hardening/scripts/probe.mjs http://localhost:4599 --protected /admin
```

The test server leaks on purpose; the probe should report 4 critical and 3
high findings.

## License

MIT
