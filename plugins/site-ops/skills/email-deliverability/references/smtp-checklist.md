# Contact form sending path

Read and report. Ask before changing env vars, DNS or code. Report names
and hostnames only; never print a password, app password or API key.

## 1. Find how the form sends mail

In the site's repo:

```bash
grep -rnE "nodemailer|createTransport|resend|@sendgrid|mailgun|postmark|@aws-sdk/client-ses|smtp" --include=*.ts --include=*.tsx --include=*.js --include=*.mjs app pages lib src 2>/dev/null | grep -v node_modules
```

Note the route (for example `app/api/contact/route.ts`) and the env vars it
reads for host, port, user, password, from and to. Typical names:
`EMAIL_SERVER` / `SMTP_HOST`, `EMAIL_PORT`, `EMAIL_SECURE`, `EMAIL_USER`,
`EMAIL_PASSWORD`, `EMAIL_FROM`, `EMAIL_TO`, or an API key such as
`RESEND_API_KEY`.

Fail when:

- The code has a hard-coded fallback host for the old provider (for
  example `process.env.EMAIL_SERVER || 'smtp.zoho.com'` after moving to
  Google). A missing env var then silently sends through the old provider.
- The route swallows send errors and still returns success, so the visitor
  sees "thanks" and the mail never leaves. It should log the error and, if
  the lead is also saved to a database, say so in the log.

## 2. Check the host's values match the mail provider

The DNS check's MX line says which provider hosts the domain's mail. The
form must send through that provider (or a sending service listed in SPF).

| Provider | SMTP host | Port / secure | Auth |
|---|---|---|---|
| Google Workspace | `smtp.gmail.com` (or `smtp-relay.gmail.com` if the admin set up relay) | 587 / `secure: false` (STARTTLS), or 465 / `true` | Mailbox address + an app password (needs 2-step verification on that account) |
| Microsoft 365 | `smtp.office365.com` | 587 / STARTTLS | Mailbox + password; SMTP AUTH must be turned on for that mailbox, and it's off by default in new tenants |
| Zoho | `smtp.zoho.com` (`.eu`, `.in` by region) | 465 / SSL or 587 | Mailbox + app password |
| Amazon SES | `email-smtp.<region>.amazonaws.com` | 587 | SMTP credentials made in the SES console (not IAM keys) |
| SendGrid / Mailgun / Postmark / Resend | `smtp.sendgrid.net`, `smtp.mailgun.org`, `smtp.postmarkapp.com`, `smtp.resend.com` | 587 | API key as password; domain must be verified with them |

After a provider move, check every one of these in the host: host, port,
secure flag, user, password, from address. We moved from one provider to
Google Workspace and the form kept failing because the host and password
still pointed at the old one.

`EMAIL_FROM` must be the authenticated mailbox or an alias that provider
lets it send as. A different from address is rewritten or rejected.

Get the host's env var names (not values) with the deploy-check skill's
`env-check.mjs`, or per host:

- **Amplify:** `aws amplify get-app --app-id <id> --query 'keys(app.environmentVariables)'`
- **Vercel:** `vercel env ls production`
- **Netlify:** `netlify env:list --context production` (shows values; read
  only the names)

Ask the user to read out the non-secret values (host, port, from) from
the console if you can't see them without printing secrets.

## 3. Amplify: env vars are baked in at build time

On AWS Amplify (Next.js SSR, platform `WEB_COMPUTE`), server code can't
read console env vars at runtime. The usual fix is build commands such as
`echo "EMAIL_USER=$EMAIL_USER" >> .env` in `amplify.yml`. That means:

- **Changing an env var in the console does nothing until the next build.**
  After any change, redeploy (Amplify console → the branch → Redeploy this
  version, or push a commit).
- A var that's set in the console but missing from those `echo` lines is
  empty at runtime. `env-check.mjs --amplify-app <id>` flags this.
- A value with `#`, `$`, spaces or quotes can be cut short by `echo`. Quote
  it in the console, or write it with `printf '%s\n'`.

Vercel and Netlify read env vars at runtime for serverless functions, but a
change still applies only to new deployments. Redeploy there too.

## 4. Send one test and read the headers

With the user's go-ahead, submit the contact form once (or use the
lead-flow-test skill), then in the receiving mailbox open the message and
show the original headers (Gmail: ⋮ → Show original). Check:

- `SPF: PASS`, `DKIM: PASS` with `d=<your domain>`, `DMARC: PASS`.
- `DKIM: PASS` but `d=` is the provider's domain (for example
  `d=sendgrid.net`): DKIM isn't aligned; set up domain authentication at
  the provider.
- The message landed in spam: note which of the three failed.

If no message arrives, read the host's function logs at the time of the
submit (Amplify: Hosting → Monitoring → logs in CloudWatch; Vercel: project
→ Logs; Netlify: Functions → the function → Logs) for the send error.
Common ones: `535 Authentication failed` (wrong password or no app
password), `ETIMEDOUT` (wrong host or port), `550 not authorized to send`
(from address not allowed).
