# Following a test lead

Use the marker from the lead test (`SITEOPS-TEST-…`) for every search.
Read the form's handler in the repo first, so you know where the lead
should go: which table, which email address, which admin page, which
third-party service.

## 1. Database

Find the table the handler writes to (for example `saveContactSubmission`
in `lib/`, a Prisma model, a Supabase `insert`). Then, with the user's
database access:

```sql
SELECT id, created_at, name, email
FROM contact_submissions            -- the table the handler writes to
WHERE message LIKE '%SITEOPS-TEST-20261108-ABC123%'
   OR name    LIKE '%SITEOPS-TEST-20261108-ABC123%';
```

- Found: note the time between submit and `created_at`, and check every
  field the form sends was stored (not truncated, not empty).
- Not found: read the host's function logs at the submit time for the
  insert error. A common cause is `DATABASE_URL` missing at runtime (the
  deploy-check skill's env check finds this on Amplify).
- Don't print the connection string. Run the query through the user's
  existing tool (psql with an env var, the Supabase or Neon console, a
  project script).

## 2. Notification email

Search the inbox the handler sends to (often `EMAIL_TO`) for the marker,
including spam and any filters or shared mailboxes.

- Found: open the original headers and check `SPF`, `DKIM` and `DMARC` all
  say pass (see the email-deliverability skill's checklist).
- In spam: note which check failed.
- Not found: function logs for the send error (`535` auth, `ETIMEDOUT`
  wrong host or port, `550` sender not allowed), then the
  email-deliverability skill.
- If the handler saves first and emails second, a found database row with
  no email means the mail step is broken, and real leads are only in the
  database. Tell the user to check the admin view for leads that never
  reached the inbox.

## 3. Auto-reply (if the form sends one)

Check the test address's inbox. If it uses the default
`site-ops-test@<domain>` and that mailbox doesn't exist, the auto-reply
bounces back to the sender; that's expected for the test, but say so.

## 4. Admin view

Open the site's admin page (for example `/admin`) as the user, or ask the
user to, and search for the marker. Check it appears with the right
fields and time zone, and that it can be marked handled or deleted from
there.

## 5. CRM, analytics and other destinations

If the handler forwards leads (HubSpot, Salesforce, Airtable, Slack, a
webhook, a "lead" event in analytics), check each one for the marker.

## 6. Clean up

Only after the user says so, delete the test lead everywhere it landed,
matching on the marker so nothing real is touched:

```sql
DELETE FROM contact_submissions
WHERE message LIKE '%SITEOPS-TEST-20261108-ABC123%';
```

Show the matching rows (and the count) first, and delete only if that
count is what you expect. Delete the notification email and auto-reply,
and remove the lead from any CRM or sheet. If analytics counted a
conversion, note it so this week's numbers can be read with that in mind.
