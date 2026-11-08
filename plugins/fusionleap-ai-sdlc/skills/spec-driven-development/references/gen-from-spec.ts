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
 * Requires: Anthropic credentials (ANTHROPIC_API_KEY in .env.local or .env,
 * or an `ant auth login` profile). Not needed for --dry-run.
 * Model: claude-opus-5-5 by default; set SPEC_GEN_MODEL to override.
 */

import * as fs from "fs";
import * as path from "path";
import Anthropic from "@anthropic-ai/sdk";
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
const MODEL = process.env.SPEC_GEN_MODEL || "claude-opus-5-5";

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

function stackContext(spec: FeatureSpec): string {
  const stack = spec.stack?.length ? spec.stack : ["TypeScript", "Vitest"];
  return stack.map((s) => `- ${s}`).join("\n");
}

function authInstruction(spec: FeatureSpec): string {
  return spec.authHelper
    ? `using the project's auth check: ${spec.authHelper}`
    : "using the project's existing auth check (leave a // TODO: naming it if unknown)";
}

function buildTestPrompt(spec: FeatureSpec): string {
  return `You are a senior TypeScript engineer. Apply the project conventions described in the spec.

Generate a complete unit test file for the following feature spec, using the test runner in the stack below
(Vitest describe/it/expect if none is listed). Mock all external dependencies (database, network, framework
request/response objects).

Tech stack context:
${stackContext(spec)}
- No external test data — use in-memory mocks

SPEC:
${JSON.stringify(spec, null, 2)}

Requirements:
1. One describe() block per function or API method
2. One it() per acceptance criterion and per example
3. Tag test names with [happy-path], [edge-case], [error-case], or [security] matching spec examples
4. Mock the auth check, database access and request/response objects as needed
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
    ? `This is an API route (${spec.api!.method} ${spec.api!.path}) in: ${spec.module}`
    : `This is a TypeScript library function in: ${spec.module}`
}

Tech stack context:
${stackContext(spec)}

SPEC:
${JSON.stringify(spec, null, 2)}

Requirements:
1. Implement all inputs as typed function parameters or NextRequest parsing
2. Include all error cases with appropriate HTTP status codes (for routes) or thrown errors
3. Add // TODO: implement comments where business logic needs to be filled in
4. Include an auth check if spec.api.auth === true, ${authInstruction(spec)}
5. Add JSDoc using the spec's description and acceptance criteria
6. Follow project conventions: async/await, no callbacks, named exports for API routes
7. Use the request/response types of the stack above for API routes, pure TypeScript for library functions
8. Mark sensitive fields with // SENSITIVE — do not log comment
9. Add: "// Scaffolded from spec: ${spec.id} v${spec.version} — fill in TODOs"

Return only the TypeScript code. No explanation outside the file.`;
}

// ── Claude API call ───────────────────────────────────────────────────────────

async function callClaude(prompt: string, taskLabel: string): Promise<string> {
  if (dryRun) {
    console.log(`\n${"─".repeat(60)}`);
    console.log(`DRY RUN — Prompt for: ${taskLabel}`);
    console.log("─".repeat(60));
    console.log(prompt);
    return `// DRY RUN — Claude API not called`;
  }

  console.log(`  → Calling Claude (${MODEL}) for ${taskLabel}...`);

  // Credentials: ANTHROPIC_API_KEY, ANTHROPIC_AUTH_TOKEN, or an `ant auth login` profile.
  const client = new Anthropic();
  let message: Anthropic.Beta.BetaMessage;
  try {
    // Streaming, because generated test files can be long. "fallbacks: default"
    // retries on another model if a safety classifier declines the request.
    message = await client.beta.messages
      .stream({
        model: MODEL,
        max_tokens: 32000,
        output_config: { effort: "high" },
        betas: ["server-side-fallback-2026-07-01"],
        fallbacks: "default",
        messages: [{ role: "user", content: prompt }],
      })
      .finalMessage();
  } catch (err) {
    const credentialsHint = "Add ANTHROPIC_API_KEY=sk-ant-... to .env.local, or run `ant auth login`.";
    if (err instanceof Anthropic.AuthenticationError) {
      console.error(`\nError: the Anthropic credentials were rejected.\n${credentialsHint}\n`);
    } else if (err instanceof Anthropic.APIConnectionError) {
      console.error("Could not reach the Claude API:", err.message);
    } else if (err instanceof Anthropic.APIError) {
      console.error(`Claude API error (${err.status}): ${err.message}`);
    } else if (err instanceof Anthropic.AnthropicError) {
      // Raised before any request, e.g. when no credentials are configured.
      console.error(`\nError: ${err.message}\n${credentialsHint}\n`);
    } else {
      console.error("Unexpected error calling Claude:", err);
    }
    process.exit(1);
  }

  if (message.stop_reason === "refusal") {
    console.error(`Claude declined to generate ${taskLabel}. Adjust the spec and try again.`);
    process.exit(1);
  }
  if (message.stop_reason === "max_tokens") {
    console.warn(`  ⚠ ${taskLabel} hit the output limit and may be cut off — split the spec or generate one output at a time.`);
  }

  return message.content
    .filter((block): block is Anthropic.Beta.BetaTextBlock => block.type === "text")
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
    if (dryRun) continue; // nothing generated, so don't overwrite earlier output
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

  if (dryRun) {
    console.log("\nDry run: no API calls made and no files written.");
    return;
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
