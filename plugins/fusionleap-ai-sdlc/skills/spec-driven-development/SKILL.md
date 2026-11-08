---
name: spec-driven-development
description: >
  FusionLeap Digital — Spec-Driven Development. Helps engineers write
  machine-readable feature specs and use Claude AI to generate unit tests,
  JSDoc documentation, and code boilerplate from them. Use when the user says
  "write a spec", "create a spec", "spec-first", "generate tests from spec",
  "machine-readable spec", "spec-driven development", "gen-from-spec",
  "spec for this feature", "write acceptance criteria as a spec",
  "PRD to spec", "JIRA to spec", "scaffold code from spec", or
  "FusionLeap spec". Also triggers on "spec-driven".
---

# Spec-Driven Development

You are implementing the FusionLeap Digital Spec-Driven Development pillar. This workflow has two parts: (1) setting up the spec infrastructure in the project, and (2) helping engineers write specs and generate code from them.

## The workflow

```
PM / Product Owner        Engineer              Claude AI
       │                      │                     │
       ▼                      ▼                     ▼
 Writes PRD          Authors .spec.ts        Reads spec →
 or JIRA ticket  →   (inputs, outputs,   →  generates tests,
                      error cases,           docs, boilerplate
                      acceptance criteria)
```

If the user pastes a PRD, ticket or requirements text, draft the spec from it, then walk them through the gaps before saving it.

## Part 1 — Set up the spec infrastructure

Do this once per project. If the user already has a `specs/` directory, skip to Part 2.

### Step 1.1 — Create the specs directory

```bash
mkdir -p specs/generated
```

### Step 1.2 — Create the spec schema

Create `specs/spec.schema.ts` using the content in `references/spec.schema.ts`.

This TypeScript interface is the contract format for all specs in the project. Every field is documented inline.

### Step 1.3 — Add the generator script

Create `scripts/gen-from-spec.ts` using the content in `references/gen-from-spec.ts`.

This script reads a spec file and calls the Claude API to generate:
- Unit test skeleton (Vitest / Jest compatible)
- JSDoc documentation block
- Code boilerplate scaffold

### Step 1.4 — Add dependencies and npm scripts to package.json

Install the generator's dependencies (skip any already present):
```bash
npm install --save-dev tsx dotenv @anthropic-ai/sdk
```

Add to `"scripts"`:
```json
"spec:gen": "tsx scripts/gen-from-spec.ts",
"spec:gen:tests": "tsx scripts/gen-from-spec.ts --tests",
"spec:gen:docs": "tsx scripts/gen-from-spec.ts --docs",
"spec:gen:scaffold": "tsx scripts/gen-from-spec.ts --scaffold"
```

### Step 1.5 — Add .gitignore entry

Add to `.gitignore`:
```
# Spec generator output — review before committing
specs/generated/
```

Note: spec source files in `specs/*.spec.ts` should be committed. Only the generated output in `specs/generated/` is gitignored.

### Step 1.6 — Check for Claude API credentials

The generator calls the Claude API (model `claude-opus-5-5`; set `SPEC_GEN_MODEL` to use another). It finds credentials in `ANTHROPIC_API_KEY` (from `.env.local` or `.env`) or an `ant auth login` profile. If neither is set, tell the user to add one:
```
ANTHROPIC_API_KEY=sk-ant-...
```

Never read or print the key's value. `--dry-run` works without credentials.

### Step 1.7 — Create a specs/README.md

Create `specs/README.md` documenting:
- How to write a new spec
- How to run the generator
- The GIVEN/WHEN/THEN convention for acceptance criteria
- The table of existing specs (update this as specs are added)

---

## Part 2 — Write a spec

When a user asks to write a spec for a feature, gather the following information through conversation. Do not ask everything at once — work through it naturally.

### Information to gather

**Basic identity:**
- What is the feature called?
- Which file or module does it live in? (e.g., `app/api/auth/session/route.ts` or `lib/bot-detection.ts`)
- Is this an API endpoint, a library function, or a React component?

**Stack** (read it from `package.json` and the code; confirm rather than ask):
- Framework, language settings, database and test runner, as the `stack` list
- How protected routes check auth in this project, as `authHelper`

**Inputs:**
- What parameters or request fields does it accept?
- Which are required vs optional?
- Are any of them sensitive (PII, tokens, credentials)?

**Outputs:**
- What does it return on success?
- What HTTP status codes does it use (for API routes)?
- Are there multiple output shapes (e.g., authenticated vs unauthenticated response)?

**Error cases:**
- What can go wrong? List each failure mode.
- What does the caller receive when each error occurs?

**Security:**
- Does it require authentication?
- Does it handle PII? How?
- Are there rate limiting requirements?

**Acceptance criteria:**
- Ask the user: "What are the must-pass conditions for this to be considered correct?"
- Format each as: `GIVEN <context> WHEN <action> THEN <expected result>`

**Examples:**
- At least one happy-path example with concrete input/output values
- At least one error-case example
- Any important edge cases

### Writing the spec file

Once you have the information, create the spec file at `specs/<feature-id>.spec.ts`.

Follow the schema exactly as defined in `specs/spec.schema.ts`. Use the example spec in `references/example-auth-session.spec.ts` as a structural guide.

Key conventions:
- `id`: kebab-case, matches the filename
- `version`: start at `"1.0.0"`
- `sensitive: true` on any input that contains PII, credentials, or session tokens
- Acceptance criteria in `GIVEN / WHEN / THEN` format
- At least one example tagged `["happy-path"]` and one tagged `["error-case"]`
- `lastUpdated`: today's date in `YYYY-MM-DD` format

### After writing the spec

Tell the user they can now generate code from it:

```bash
# Generate unit tests
npm run spec:gen -- --spec specs/<feature-id>.spec.ts --tests

# Generate JSDoc documentation
npm run spec:gen -- --spec specs/<feature-id>.spec.ts --docs

# Generate code scaffold
npm run spec:gen -- --spec specs/<feature-id>.spec.ts --scaffold

# Generate all three
npm run spec:gen -- --spec specs/<feature-id>.spec.ts --all

# Preview the Claude prompt without calling the API
npm run spec:gen -- --spec specs/<feature-id>.spec.ts --all --dry-run
```

---

## Part 3 — Review generated output

Remind the user:
- Generated files land in `specs/generated/` — review before committing
- Generated code is a starting point, not production-ready output
- The spec is the source of truth: if generated code diverges from intent, fix the spec first and regenerate
- Commit the spec file and any reviewed generated tests together

---

## Important notes

- Never include actual secret values in spec examples — use placeholder strings like `"sess_abc123"` or `"sk-ant-REPLACE_ME"`
- If the user is on a team, encourage them to write specs for every new feature before writing code — this is the core discipline of spec-driven development
- If the user mentions a JIRA ticket or PRD, ask them to paste its text and draft the spec from it. There is no JIRA integration; work only from what they paste.
