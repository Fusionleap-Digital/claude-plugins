# Hosts: env vars, deploys and rollback

Read and report. Ask the user before changing env vars, starting a build or
rolling back.

## AWS Amplify (Hosting, Gen 1 and Gen 2)

**Env vars**

- Console: App → Hosting → Environment variables. Per-branch overrides are
  on the same page.
- Names only from the CLI:
  `aws amplify get-app --app-id <id> --query 'keys(app.environmentVariables)'`
  and `aws amplify get-branch --app-id <id> --branch-name main --query 'keys(branch.environmentVariables)'`.
- Next.js SSR (`platform: WEB_COMPUTE`): server code only sees console env
  vars that the build writes into `.env`, for example in `amplify.yml`:
  ```yaml
  build:
    commands:
      - env | grep -e EMAIL_ -e DATABASE_URL -e NEXT_PUBLIC_ >> .env.production
      - npm run build
  ```
  So a change takes effect only after the next build. A var missing from
  those lines is empty at runtime.
- Secrets can also live in AWS Secrets Manager / SSM Parameter Store (Gen 2:
  `secret()` in `amplify/backend.ts`). Those still need a redeploy to change.

**Deploy**

- Push to the connected branch, or Console → branch → Redeploy this version.
- CLI: `aws amplify start-job --app-id <id> --branch-name main --job-type RELEASE`.
- Watch: `aws amplify list-jobs --app-id <id> --branch-name main --max-items 5`.

**Roll back**

1. Console → the branch → Deployments: pick the last good deployment →
   **Redeploy this version**. This re-ships that build, including the env
   vars it baked in.
2. Or revert the commit and push: `git revert <bad-sha> && git push`.
3. If the bad deploy came from an env var change, fix the var first, then
   redeploy; redeploying the old build alone brings back the old values
   only if they were baked into that build.
4. Run the smoke test again.

## Vercel

**Env vars**

- Project → Settings → Environment Variables, per environment (Production,
  Preview, Development).
- Names: `vercel env ls production`. Values are encrypted in that listing;
  don't use `vercel env pull` here, it writes values to a local file.
- A change applies to new deployments only: redeploy.
- `NEXT_PUBLIC_` values are inlined at build time.

**Deploy**

- Push to the production branch, or `vercel --prod`.

**Roll back**

1. Project → Deployments → the last good production deployment → ⋯ →
   **Instant Rollback** (or **Promote to Production**). No rebuild.
2. CLI: `vercel rollback <deployment-url>` (or `vercel rollback` for the
   previous one).
3. After an instant rollback, Vercel stops auto-promoting new pushes until
   you promote one again. Tell the user.
4. Run the smoke test again.

## Netlify

**Env vars**

- Site configuration → Environment variables, with per-context values
  (production, deploy previews, branch deploys).
- Names: `netlify env:list --context production` shows values too; take
  the names only. `netlify.toml` `[context.production.environment]` values
  are in the repo and override nothing secret, so keep secrets out of it.
- A change applies to the next build: trigger a deploy.

**Deploy**

- Push to the production branch, or `netlify deploy --build --prod`.

**Roll back**

1. Deploys → the last good deploy → **Publish deploy**. No rebuild.
2. Turn off auto publishing (Deploys → Stop auto publishing) if the next
   push would ship the same bug, and turn it back on after the fix.
3. Run the smoke test again.

## Any host: before you roll back

- Is it the deploy, or something outside it (DNS, the database, a third
  party, an expired certificate)? The ops digest checks the last two.
- Did the deploy include a database migration? Rolling back the code
  doesn't undo it. Check the old code works with the new schema first.
- Write down the bad commit and what broke, so the fix lands with a test.
