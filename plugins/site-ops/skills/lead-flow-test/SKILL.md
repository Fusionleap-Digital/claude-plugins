---
name: lead-flow-test
description: Send one clearly marked test lead through a contact or demo form on a website the user owns, then check it reached the database, the notification email and the admin view, and clean it up. Use when the user asks to test their contact form, check that leads or form submissions still arrive, after a deploy or a mail provider change that touched the form, or when they suspect leads are being lost.
---

# Lead flow test

A form can show "Thanks!" while the lead goes nowhere: the email fails,
the database insert fails, or the admin view hides it. This skill sends one
test lead with a unique marker and follows it to every place it should
land.

## Rules

- **The user's own site only, and ask before submitting.** Show the user
  the endpoint and the exact payload from the dry run and get a clear yes.
  Then run with `--submit` once. Never submit in a loop or retry
  automatically.
- **Ownership proof is required to submit.** The script refuses a public
  host unless `https://<site>/.well-known/site-ops.txt` contains
  `site-ops-verification=<any-id>`, or a DNS TXT record on
  `_site-ops.<site>` has that value (the site-hardening proof works too).
  Local hosts (`localhost`, `*.test`) need none. Don't work around it.
- **Mark it as a test everywhere.** The script puts the marker
  (`SITEOPS-TEST-<date>-<id>`) in the name, company and message, and uses an
  address on the user's own domain. Don't change it to look like a real
  lead.
- **Never pass a CAPTCHA.** If the form has reCAPTCHA, hCaptcha or
  Turnstile, the user submits by hand in a browser and you follow the
  checklist with the marker they typed.
- **Read-only downstream unless told otherwise.** Look for the lead in the
  database, inbox and admin view; delete it only when the user says so, and
  only the rows that carry the marker.
- **Never print secrets** (database URLs, SMTP passwords, admin passwords)
  while checking.

## 1. Dry run

```bash
node "${CLAUDE_PLUGIN_ROOT}/skills/lead-flow-test/scripts/lead-test.mjs" https://example.com --page /contact
```

- Reads the page, lists the form's fields, fills them with test values and
  finds the endpoint: the form's `action`, or, for forms posted with
  JavaScript, `/api/...` paths in the page's own scripts. Confirm the
  endpoint in the repo's submit handler, and pass `--endpoint` if the guess
  is wrong.
- Fields the HTML doesn't show (forms drawn in the browser) can be set with
  `--field key=value` (repeatable). Read the handler to get the keys the
  endpoint expects.
- `--email` sets the test lead's address (default
  `site-ops-test@<site domain>`). Use a mailbox the user reads if the form
  sends an auto-reply.
- `--encoding json|form`: JSON for `fetch` handlers (default when there's
  no `action`), form-encoded for plain HTML forms.

Show the user the endpoint and payload, and ask to send it.

## 2. Submit

```bash
node "${CLAUDE_PLUGIN_ROOT}/skills/lead-flow-test/scripts/lead-test.mjs" https://example.com --page /contact --endpoint /api/contact --marker SITEOPS-TEST-20261108-ABC123 --submit
```

Reuse the marker from the dry run so the report and checklist match. It
sends exactly one request and records the status and the response's JSON
keys (not its values). Exit code 1 means the endpoint returned an error.

## 3. Follow the lead

Work through `references/lead-checklist.md` with the marker: database row,
notification email (and its SPF/DKIM/DMARC result), auto-reply, admin
view, CRM or analytics, server logs. Then clean up.

## Report

One line per place the lead should land: found or not, how long it took,
and anything wrong (missing fields, landed in spam, admin view didn't show
it). Then what was cleaned up. If something failed, point to the likely
cause (SMTP settings: the email-deliverability skill; env vars: the
deploy-check skill).
