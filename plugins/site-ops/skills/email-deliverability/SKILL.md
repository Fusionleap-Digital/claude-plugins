---
name: email-deliverability
description: Check a domain's email DNS (SPF, DKIM, DMARC, MX) for the mistakes that send mail to spam or get it rejected, and check the website contact form's SMTP path. Use when the user says their emails go to spam, contact-form emails stopped arriving, they moved mail providers (for example to or from Google Workspace or Microsoft 365), they're setting up SPF, DKIM or DMARC, Gmail or Yahoo bulk-sender rules come up, or they want an email deliverability check for their domain.
---

# Email deliverability

Two parts:

1. **DNS check** (`scripts/email-dns.mjs`): SPF, DKIM, DMARC and MX.
2. **Sending path checklist** (`references/smtp-checklist.md`): how the
   site's contact form actually sends mail.

Every check here comes from a mistake we made or found on our own domains:
an SPF record created at a subdomain literally named `@`, a DKIM key pasted
at the domain root, two SPF records after a provider move, no DMARC record,
and a contact form still sending through the old provider.

## Rules

- **The user's own domains only.** DNS records are public, but only run this
  for domains the user runs or has been asked to fix.
- **Read-only.** The script only does DNS lookups, plus (with `--smtp-host`)
  one connection that says EHLO and QUIT. It never logs in or sends mail.
- **Never print secrets.** When reading the site's env vars for the
  checklist, report names and hostnames, never passwords or API keys.
- **Ask before changing DNS or env vars.** Draft the exact record (name,
  type, value) and say where it goes; let the user make the change unless
  they ask you to.

## 1. DNS check

```bash
node "${CLAUDE_PLUGIN_ROOT}/skills/email-deliverability/scripts/email-dns.mjs" example.com --smtp-host smtp.gmail.com
```

- `--selector s1,s2` adds DKIM selectors to the ~35 common ones it tries.
  The selector is the `s=` value in the `DKIM-Signature` header of a mail
  the domain sent. Ask the user for one if no key is found.
- `--smtp-host` (and `--smtp-port`, default 587) is the host the site's
  contact form sends through. Find it in the repo (for example
  `EMAIL_SERVER`, `SMTP_HOST`, or a nodemailer / Resend / SendGrid setup).
  The script checks it matches the provider in MX and SPF, and that it
  answers.
- `--no-mail` for domains that send and receive no mail (they should still
  have `v=spf1 -all`, a null MX and a DMARC reject policy).
- `--resolver 1.1.1.1` to ask a public resolver instead of the system one,
  useful right after a DNS change.
- Writes `report.md` and `report.json`. Exit code 1 means a critical or high
  finding.

| Check | Fails when |
|---|---|
| spf-missing / spf-multiple | No SPF record, or more than one (receivers then fail SPF for every message) |
| spf-pass-all, spf-neutral-all, spf-no-all | SPF ends in `+all`, `?all`, or has no `all` |
| spf-too-many-lookups | SPF needs more than 10 DNS lookups |
| record-at-literal-at | A record sits at `\100.<domain>`: someone typed `@` as the record name in Route 53 or a similar console, which creates a subdomain literally named "@" |
| dkim-at-root | A DKIM key is in the root TXT records instead of `<selector>._domainkey` |
| dkim-not-found, dkim-weak, dkim-revoked | No key at any selector tried; key under 1024 bits; empty `p=` |
| dmarc-missing, dmarc-multiple, dmarc-at-root | No DMARC at `_dmarc.<domain>`, more than one, or one at the root |
| dmarc-monitor-only, dmarc-no-reports | `p=none`; no `rua=` address (low, but say when to move on) |
| mx-missing, mx-mixed | No MX; MX points at two providers (leftover from a move) |
| smtp-provider-mismatch, smtp-not-in-spf | The form sends through a provider that MX or SPF don't list |
| smtp-unreachable | The SMTP host doesn't answer on that port |

## 2. Sending path checklist

Work through `references/smtp-checklist.md` with the user's repo and host.
It covers where the form's mail settings live, the Amplify `.env`-at-build
trap (changing an env var does nothing until the next build), and how to
send one test message and read its headers.

## Report

Lead with anything that stops mail now (multiple SPF, record at `@`,
provider mismatch, unreachable SMTP), then what sends mail to spam (no
DKIM, no DMARC), then improvements (`p=none` to `quarantine`, 2048-bit
keys). For each, give the exact DNS record or env var change and where to
make it. After the user changes DNS, run the check again with
`--resolver 1.1.1.1` and show before and after.
