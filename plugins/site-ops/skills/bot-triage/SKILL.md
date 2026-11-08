---
name: bot-triage
description: Read a website's access log and check whether requests claiming to be crawlers (GPTBot, ClaudeBot, CCBot, Googlebot, Bingbot, Bytespider, Amazonbot, PerplexityBot, Applebot and others) are genuine, using the IP ranges the crawler owners publish and reverse-then-forward DNS; then summarize which are fake, where they come from and what they asked for. Use when the user asks whether AI crawler or bot traffic is real, sees lots of GPTBot/ClaudeBot hits in analytics or logs, wants to know who is requesting .env or config files, or gives an access log (Amplify, CloudFront, Vercel, Netlify, nginx, Apache, CSV) to triage.
---

# Bot traffic triage

Any client can put "GPTBot" in its user agent. In October 2026, about half
of fusionleap.io's "AI crawler" traffic came from ten cloud servers that
rotated through crawler names and asked for `.env` and config files. This
skill sorts claimed crawler requests into genuine, fake and can't-tell, so
the user stops trusting the user agent.

## Rules

- **The user's own logs only.** Access logs hold visitors' IP addresses.
  Keep the report to crawler claims and secret-file scanners, which is what
  the script outputs; don't list ordinary visitors' IPs.
- **Read-only.** The script reads the log, downloads the published crawler
  IP lists (cached for a day), and does DNS lookups. It sends nothing to the
  user's site.
- **Don't block on user agent alone, and ask before changing firewall or
  WAF rules.** Blocking "GPTBot" blocks the real one too; the fakes just
  change names.

## Get the log

- **AWS Amplify:** Hosting → Monitoring → Access logs, or
  `aws amplify generate-access-logs --app-id <id> --domain-name example.com --start-time <iso> --end-time <iso>`
  (returns a link to a CSV; long ranges are refused, so ask for one day at
  a time and pass all the files).
- **CloudFront:** standard logs from the S3 bucket (gzip; `gunzip` first).
- **Vercel / Netlify:** a log drain or the dashboard's export (JSON lines).
- **nginx / Apache:** the access log in combined format.
- **Anything else:** a CSV with a header row that has ip, user-agent and
  path columns.

## Run

```bash
node "${CLAUDE_PLUGIN_ROOT}/skills/bot-triage/scripts/bot-verify.mjs" access-2026-11-05.csv access-2026-11-06.csv
```

- Format is detected (`--format amplify|cloudfront|combined|csv|jsonl` to
  force it).
- `--no-dns` checks published IP ranges only (fast, but Amazonbot, which
  publishes only DNS names, then can't be checked). `--max-ips` caps DNS
  lookups (default 300).
- Writes `report.md` and `report.json`. Exit code 1 means a scanner got a
  2xx answer to a secret or config path.

How each claim is checked, per `references/crawlers.md`:

1. IP is in the owner's published ranges → **genuine**.
2. Owner publishes DNS names: reverse DNS of the IP must end in one of
   them, and that name must resolve back to the same IP → **genuine**,
   otherwise **fake**.
3. Owner publishes ranges but the IP isn't in them → **fake**.
4. Owner publishes neither (Bytespider, meta-externalagent, cohere-ai) →
   **can't be verified**. Judge by behavior: a crawler asking for `/.env`
   is a scanner whatever it's called.

## Read the results

- **Rotating names.** One IP using several crawler names is a scanner,
  always. Real crawlers use one name.
- **Network.** Reverse DNS like `ec2-…compute.amazonaws.com` or
  `…bc.googleusercontent.com` means a rented cloud server, not the crawler's
  owner.
- **What they asked for.** Count of secret/config paths (`.env`, `.git`,
  `wp-config`, `amplify/`, `*.tfstate`, …). The report also lists clients
  with ordinary browser user agents that asked for those paths.
- **Got 2xx.** A scanner that got a 2xx for a secret path is the only
  urgent finding. Run the site-hardening plugin's probe to see whether that
  path really serves content or just a soft-404 page.

## What to recommend

1. Make sure every secret path returns 404: run the site-hardening probe.
   This is the fix; everything below just cuts noise.
2. If the fakes are noisy, block them at the edge by **IP or network**, not
   by user agent: AWS WAF on Amplify/CloudFront, Vercel Firewall, Netlify
   (Enterprise) or Cloudflare. Ask first; WAF has a monthly cost.
3. For analytics, filter crawler traffic by verified IP, not user agent.
4. Keep robots.txt rules for the real crawlers as the user wants them; fake
   crawlers ignore robots.txt anyway.

## Report

Start with the share of claimed crawler traffic that is fake, then the top
fake IPs (network, names used, what they asked for), then anything that got
a 2xx. Say which crawlers couldn't be verified and why, and the log's time
span.
