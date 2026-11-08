# Repo checklist

Run from the site's repo root. Commands work in bash and zsh. Each item: the check, the command, and what a
failure looks like. Report file:line for every failure.

## Every framework

1. **Secrets committed to git.** Look for key and env files, including in history.
   ```bash
   git ls-files | grep -iE '(^|/)\.env($|\.)|\.pem$|\.key$|id_(rsa|ed25519)|service.?account.*\.json|credentials\.json|\.tfstate|\.tfvars$|\.npmrc$|\.pgpass'
   git log --all --diff-filter=A --name-only --format= | grep -iE '\.env($|\.)|\.pem$|\.key$|service.?account|\.tfstate' | sort -u
   ```
   Fail: any match other than `.env.example` with placeholder values. A file
   that was ever committed must be treated as leaked: rotate the secret, then
   remove it.

2. **`.gitignore` covers secrets.** It should list `.env*` (with
   `!.env.example`), `*.pem`, `*.key`, `.terraform/`, `*.tfstate*`,
   `amplify/team-provider-info.json`, `.vercel`, `.dev.vars`.

3. **Files in the public folder.** Everything in `public/` (or `static/`,
   `dist/`) is served as-is.
   ```bash
   find public static 2>/dev/null -type f | grep -viE '\.(png|jpe?g|webp|avif|gif|svg|ico|woff2?|ttf|otf|mp4|webm|pdf|txt|xml|webmanifest)$'
   ```
   Fail: any JSON, YAML, env, key, SQL or archive file that isn't meant for
   the public. Also open `robots.txt` and `llms.txt`: they shouldn't list
   private paths.

4. **Hard-coded secrets in source.**
   ```bash
   grep -rnE "(sk_live_|sk-[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16}|-----BEGIN [A-Z ]*PRIVATE KEY|service_role|mongodb(\+srv)?://[^:]+:[^@]+@|postgres(ql)?://[^:]+:[^@]+@)" --include='*.js' --include='*.ts' --include='*.tsx' --include='*.jsx' --include='*.mjs' --include='*.cjs' --include='*.json' --include='*.yml' --include='*.yaml' --include='*.toml' --exclude-dir=node_modules --exclude-dir=.next --exclude-dir=.git .
   ```

5. **Routes that read files from user input.** Path traversal starts here.
   ```bash
   grep -rnE "(readFile|createReadStream|sendFile|res\.download|fs\.(read|open))\w*\(" --include='*.js' --include='*.ts' --include='*.mjs' app pages src lib server api 2>/dev/null
   ```
   Fail: the path comes from a query, body, header or route param without
   `path.resolve` + a check that the result stays inside an allowed folder.

6. **Error pages leak details.** Look for handlers that return `err.stack`,
   `err.message` or `process.env` in production responses.

## Next.js

7. **Browser env vars.** Anything prefixed `NEXT_PUBLIC_` is built into the
   JavaScript every visitor downloads.
   ```bash
   grep -rnoE "NEXT_PUBLIC_[A-Z0-9_]+" --include='*.js' --include='*.ts' --include='*.tsx' --include='*.jsx' --exclude-dir=node_modules --exclude-dir=.next . | sed 's/.*://' | sort -u
   ```
   Fail: names containing SECRET, PRIVATE, SERVICE_ROLE, ADMIN, PASSWORD, or
   any key that grants write access.

8. **Production source maps.** In `next.config.*`,
   `productionBrowserSourceMaps: true` publishes your source. Fail if set.

9. **Middleware matches raw paths.** Open `middleware.ts` / `proxy.ts`. If it
   guards routes with `pathname.startsWith('/admin')` or a `matcher`, check
   that `/%2Fadmin`, `//admin` and `/admin/` can't skip it. Safest: check auth
   inside the protected route or layout too, not only in middleware.

10. **Security headers.** `next.config.*` `headers()` (or middleware) should
    set Strict-Transport-Security, Content-Security-Policy (with
    `frame-ancestors`), X-Content-Type-Options, Referrer-Policy. Set
    `poweredByHeader: false`.

11. **API routes without auth.** List `app/api/**/route.ts` and
    `pages/api/**`. For each one that returns user or config data, confirm it
    checks the session first.

## Other frameworks

- **Vite / SvelteKit / Astro:** `import.meta.env.VITE_*` and `PUBLIC_*` are
  public, same as `NEXT_PUBLIC_`. Never expose the dev server (`/@fs/`,
  `__vite`) to the internet. `build.sourcemap` should be off or `hidden`.
- **Nuxt:** only `runtimeConfig.public` reaches the browser; check nothing
  secret is there. `_payload.json` files are public by design: make sure
  they don't carry private data.
- **Express / Fastify:** `express.static` on the project root serves
  everything, including `.env`. Point it at a dedicated folder.
- **PHP / WordPress:** no `*.bak`, `*.old`, `phpinfo.php` or SQL dumps in
  the web root.
