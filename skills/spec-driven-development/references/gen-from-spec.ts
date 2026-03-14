#!/usr/bin/env tsx
/**
 * FusionLeap Spec-to-Code Generator
 *
 * Reads a machine-readable spec file and uses Claude AI to generate:
 *   --tests     Unit test skeleton (Vitest/Jest compatible)
 *   --docs      JSDoc documentation block
 *   --scaffold  Code boilerplate matching the spec's inputs/outputs
 *
 * Usage:
 *   npx tsx scripts/gen-from-spec.ts --spec specs/auth-session.spec.ts --tests
 *   npx tsx scripts/gen-from-spec.ts --spec specs/bot-detection.spec.ts --docs
 *   npx tsx scripts/gen-from-spec.ts --spec specs/auth-session.spec.ts --scaffold
 *   npx tsx scripts/gen-from-spec.ts --spec specs/auth-session.spec.ts --all
 *
 * Requires: ANTHROPIC_API_KEY in environment (add to .env.local or .env)
 */

import * as fs from "fs";
import * as path from "path";
import { config as loadDotenv } from "dotenv";

// Load env files in Next.js priority order: .env.local overrides .env
loadDotenv({ path: path.resolve(process.cwd(), ".env") });
loadDotenv({ path: path.resolve(process.cwd(), ".env.local"), override: true });
import type { FeatureSpec } from "../specs/spec.schema";

// ── CLI args ──────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);

function getArg(flag: string): string | null {
  const idx = args.indexOf(flag);
  return idx !== -1 ? (args[idx + 1] ?? null) : null;
}

const specPath = getArg("--spec");
const genTests = args.includes("--tests") || args.includes("--all");
const genDocs = args.includes("--docs") || args.includes("--all");
const genScaffold = args.includes("--scaffold") || args.includes("--all");
const dryRun = args.includes("--dry-run");

if (!specPath) {
  console.error(`
Usage: npx tsx scripts/gen-from-spec.ts --spec <path> [--tests] [--docs] [--scaffold] [--all] [--dry-run]

  --spec      Path to a .spec.ts file in the specs/ directory
  --tests     Generate unit test skeleton
  --docs      Generate JSDoc documentation
  --scaffold  Generate code boilerplate
  --all       Generate all three outputs
  --dry-run   Print the prompt to Claude without calling the API

Examples:
  npx tsx scripts/gen-from-spec.ts --spec specs/auth-session.spec.ts --tests
  npx tsx scripts/gen-from-spec.ts --spec specs/bot-detection.spec.ts --all
`);
  process.exit(1);
}

if (!genTests && !genDocs && !genScaffold) {
  console.error(
    "Error: specify at least one of --tests, --docs, --scaffold, or --all",
  );
  process.exit(1);
}

// ── Load spec ────────────────────────────────────────────────────────────────

async function loadSpec(filePath: string): Promise<FeatureSpec> {
  const absPath = path.resolve(process.cwd(), filePath);
  if (!fs.existsSync(absPath)) {
    console.error(`Spec file not found: ${absPath}`);
    process.exit(1);
  }
  const module = await import(absPath);
  const spec: FeatureSpec = module.default;
  if (!spec?.id || !spec?.feature) {
    console.error(`Invalid spec file: missing required fields (id, feature)`);
    process.exit(1);
  }
  return spec;
}

// ── Prompt builders ───────────────────────────────────────────────────────────

function buildTestPrompt(spec: FeatureSpec): string {
  return `You are a senior TypeScript engineer. Apply the project conventions described in the spec.

Generate a complete unit test file for the following feature spec. Use Vitest (describe/it/expect).
Mock all external dependencies (MongoDB, fetch, Next.js request/response) using vi.mock().

Tech stack context:
- Next.js 14 App Router
- TypeScript strict mode
- MongoDB / Mongoose
- No external test data — use in-memory mocks

SPEC:
${JSON.stringify(spec, null, 2)}

Requirements:
1. One describe() block per function or API method
2. One it() per acceptance criterion and per example
3. Tag test names with [happy-path], [edge-case], [error-case], or [security] matching spec examples
4. Mock getSession(), MongoDB models, and NextRequest/NextResponse as needed
5. Include a // TODO: comment for any example marked sensitive=true showing what NOT to assert
6. Add a top-level comment: "Auto-generated from spec: ${spec.id} v${spec.version} — review before merging"

Return only the TypeScript code. No explanation text outside the file.`;
}

function buildDocsPrompt(spec: FeatureSpec): string {
  return `You are a senior TypeScript engineer.

Generate a JSDoc documentation block for the following feature spec.
The output should be a single JSDoc comment block that can be placed directly
above the function or route handler in ${spec.module}.

SPEC:
${JSON.stringify(spec, null, 2)}

Requirements:
1. Include @description with a concise 2–3 sentence summary
2. One @param tag per input (mark sensitive params with @param {sensitive})
3. One @returns tag per output variant
4. One @throws tag per error case
5. Include @example with a realistic code snippet
6. Include @security tags for each security requirement
7. If the spec has a jiraTicket, include @see tag linking to it
8. Add: "@generated Auto-generated from spec: ${spec.id} v${spec.version}"

Return only the JSDoc comment block. No surrounding code.`;
}

function buildScaffoldPrompt(spec: FeatureSpec): string {
  const isApiRoute = !!spec.api;
  return `You are a senior TypeScript engineer. Apply the project conventions described in the spec.

Generate a TypeScript code scaffold for the following feature spec.
${
  isApiRoute
    ? `This is a Next.js 14 App Router API route at: ${spec.api!.path}`
    : `This is a TypeScript library function in: ${spec.module}`
}

SPEC:
${JSON.stringify(spec, null, 2)}

Requirements:
1. Implement all inputs as typed function parameters or NextRequest parsing
2. Include all error cases with appropriate HTTP status codes (for routes) or thrown errors
3. Add // TODO: implement comments where business logic needs to be filled in
4. Include auth check if spec.api.auth === true (call isAuthenticated() from @/lib/auth)
5. Add JSDoc using the spec's description and acceptance criteria
6. Follow project conventions: async/await, no callbacks, named exports for API routes
7. Use NextRequest / NextResponse for API routes, pure TypeScript for library functions
8. Mark sensitive fields with // SENSITIVE — do not log comment
9. Add: "// Scaffolded from spec: ${spec.id} v${spec.version} — fill in TODOs"

Return only the TypeScript code. No explanation outside the file.`;
}

// ── Claude API call ───────────────────────────────────────────────────────────

async function callClaude(prompt: string, taskLabel: string): Promise<string> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.error(
      "\nError: ANTHROPIC_API_KEY not set.\n" +
        "Add it to .env.local or .env:\n" +
        "  ANTHROPIC_API_KEY=sk-ant-...\n",
    );
    process.exit(1);
  }

  if (dryRun) {
    console.log(`\n${"─".repeat(60)}`);
    console.log(`DRY RUN — Prompt for: ${taskLabel}`);
    console.log("─".repeat(60));
    console.log(prompt);
    return `// DRY RUN — Claude API not called`;
  }

  console.log(`  → Calling Claude API for ${taskLabel}...`);

  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-opus-4-6",
      max_tokens: 4096,
      messages: [{ role: "user", content: prompt }],
    }),
  });

  if (!response.ok) {
    const err = await response.text();
    console.error(`Claude API error (${response.status}): ${err}`);
    process.exit(1);
  }

  const data = (await response.json()) as {
    content: Array<{ type: string; text: string }>;
  };

  return data.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n");
}

// ── Output writer ─────────────────────────────────────────────────────────────

function writeOutput(
  specId: string,
  type: "tests" | "docs" | "scaffold",
  content: string,
): string {
  const suffixMap = {
    tests: ".test.ts",
    docs: ".jsdoc.ts",
    scaffold: ".scaffold.ts",
  };
  const outDir = path.resolve(process.cwd(), "specs", "generated");
  fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, `${specId}${suffixMap[type]}`);
  fs.writeFileSync(outPath, content, "utf8");
  return outPath;
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const spec = await loadSpec(specPath!);

  console.log(`\n╔═══════════════════════════════════════════════════╗`);
  console.log(`║  FusionLeap Spec Generator — ${spec.id.padEnd(23)}║`);
  console.log(`╚═══════════════════════════════════════════════════╝`);
  console.log(`  Feature: ${spec.feature}`);
  console.log(`  Module:  ${spec.module}`);
  console.log(`  Spec v:  ${spec.version}`);
  console.log("");

  const tasks: Array<{
    label: string;
    type: "tests" | "docs" | "scaffold";
    prompt: string;
  }> = [];

  if (genTests)
    tasks.push({
      label: "Unit Tests",
      type: "tests",
      prompt: buildTestPrompt(spec),
    });
  if (genDocs)
    tasks.push({
      label: "JSDoc Docs",
      type: "docs",
      prompt: buildDocsPrompt(spec),
    });
  if (genScaffold)
    tasks.push({
      label: "Code Scaffold",
      type: "scaffold",
      prompt: buildScaffoldPrompt(spec),
    });

  const results: Array<{ type: string; path: string }> = [];

  for (const task of tasks) {
    console.log(`▶ Generating ${task.label}...`);
    const output = await callClaude(task.prompt, task.label);
    // Strip markdown code fences if Claude wrapped the output
    const clean = output
      .replace(/^```(?:typescript|ts|javascript|js)?\n?/m, "")
      .replace(/\n?```\s*$/m, "")
      .trim();

    const outPath = writeOutput(spec.id, task.type, clean);
    results.push({ type: task.label, path: outPath });
    console.log(`  ✔ Written → ${path.relative(process.cwd(), outPath)}`);
    console.log("");
  }

  console.log(`╔═══════════════════════════════════════════════════╗`);
  console.log(`║  ✅ Generation complete                           ║`);
  console.log(`╚═══════════════════════════════════════════════════╝`);
  console.log("");
  console.log("Generated files (review before committing):");
  for (const r of results) {
    console.log(
      `  ${r.type.padEnd(16)} → specs/generated/${spec.id}${r.type === "Unit Tests" ? ".test.ts" : r.type === "JSDoc Docs" ? ".jsdoc.ts" : ".scaffold.ts"}`,
    );
  }
  console.log("");
  console.log(
    "⚠  Claude-generated code must be reviewed by an engineer before merging.",
  );
  console.log(
    "   The spec is the source of truth — if generated code diverges, fix the spec first.",
  );
}

main().catch((err) => {
  console.error("Unexpected error:", err);
  process.exit(1);
});
