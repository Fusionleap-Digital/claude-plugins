# Running the digest every week

Three ways, from least to most setup. Each runs the same command; only the
place it runs changes.

## Claude Code routines (cloud)

A routine is a Claude Code agent that runs on a schedule in the cloud,
with your repo checked out. In Claude Code, run `/schedule` and describe
the job, for example:

> Every Monday at 8:00 America/Los_Angeles, in the fusion-leap-digital
> repo: install the site-ops plugin from Fusionleap-Digital/claude-plugins,
> run the ops digest for https://fusionleap.io with --repo . and
> --tls-host www.fusionleap.io, compare it with last week's report in
> ops/digests/, commit this week's report.json and report.md to
> ops/digests/<date>/ on a branch, and open a PR titled "Ops digest
> <date>" with the Needs attention list as the description. If nothing
> needs attention, say so in one line.

Things to check when setting it up:

- **Network access.** The routine's environment must be able to reach the
  site, DNS, `data.iana.org` and the RDAP server for your TLD, the npm
  registry, and (for bot triage) the crawler IP lists. If the environment
  limits outbound hosts, allow these or use full network access.
- **No Chrome in the cloud by default.** Leave out `--lighthouse` unless
  the environment has Chrome, or run Lighthouse locally once a month.
- **Access logs and AWS.** A cloud routine has no AWS credentials unless
  you give the environment some. Either skip bot triage there, or add a
  read-only IAM user limited to `amplify:GenerateAccessLogs` for that one
  app and store its keys as environment secrets.
- **Where the report goes.** A PR or a committed file keeps history the
  next run can compare with. Pick one; don't post reports anywhere public.
- **What counts as urgent.** Ask the routine to put critical and high
  findings in the PR title (for example "Ops digest: 1 critical") so they
  stand out in notifications.

## Local scheduled task (desktop app)

If the checks need things only your machine has (AWS credentials for
access logs, Chrome for Lighthouse), schedule it in the Claude desktop
app's scheduled tasks instead, with the same prompt. It runs only while
the computer is awake.

## GitHub Actions (no Claude)

The scripts need nothing but Node, so a plain workflow works when you only
want the report:

```yaml
name: ops-digest
on:
  schedule: [{ cron: '0 15 * * 1' }]   # Mondays 15:00 UTC
  workflow_dispatch:
jobs:
  digest:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 22 }
      - run: git clone --depth 1 https://github.com/Fusionleap-Digital/claude-plugins /tmp/fl
      - run: node /tmp/fl/plugins/site-ops/skills/ops-digest/scripts/digest.mjs https://example.com --repo . --out digest
      - uses: actions/upload-artifact@v4
        if: always()
        with: { name: ops-digest, path: digest }
```

The job fails (exit code 1) on a critical or high finding, which gives you
GitHub's failure email for free. Claude isn't involved, so there's no
week-over-week comparison or drafted fixes; open the report with Claude
when it fails.
