/**
 * FusionLeap Spec-Driven Development — Machine-Readable Spec Schema
 *
 * Every feature or API endpoint in your project should have a corresponding spec
 * file in this directory. Specs are the single source of truth for:
 *   - What a function/API does
 *   - Its inputs, outputs, and error cases
 *   - Security and privacy requirements
 *   - Acceptance criteria for QA
 *
 * Claude AI uses these specs to generate:
 *   - Unit test skeletons  →  scripts/gen-from-spec.ts --tests
 *   - JSDoc documentation  →  scripts/gen-from-spec.ts --docs
 *   - Code boilerplate     →  scripts/gen-from-spec.ts --scaffold
 *
 * Phase 2: PMs write PRDs/JIRA tickets → Claude drafts this spec for engineer review.
 */

// ── Core Types ────────────────────────────────────────────────────────────────

export type SpecSeverity = "low" | "medium" | "high" | "critical";
export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
export type ParamType =
  | "string"
  | "number"
  | "boolean"
  | "object"
  | "array"
  | "Date"
  | "null"
  | "undefined";

export interface Parameter {
  name: string;
  type: ParamType | string; // allow complex types like 'Record<string, unknown>'
  required: boolean;
  description: string;
  validation?: string[]; // e.g. ["non-empty", "valid ObjectId", "max 255 chars"]
  example?: unknown;
  sensitive?: boolean; // marks PII / secret fields (email, fingerprint, token)
}

export interface ReturnValue {
  type: string;
  description: string;
  example?: unknown;
  httpStatus?: number; // for API routes
}

export interface ErrorCase {
  code: string; // e.g. "AUTH_MISSING", "SITE_NOT_FOUND"
  condition: string; // human-readable: when does this happen
  httpStatus?: number; // for API routes
  response?: unknown; // example response body
}

export interface SideEffect {
  type:
    | "database_write"
    | "database_read"
    | "email"
    | "external_api"
    | "cache"
    | "log";
  description: string;
  collection?: string; // MongoDB collection name, if applicable
}

export interface TestExample {
  description: string;
  input: Record<string, unknown>;
  expectedOutput?: unknown;
  expectedError?: string; // error code if this example should throw
  tags?: string[]; // e.g. ["happy-path", "edge-case", "security"]
}

export interface SecurityRequirement {
  type:
    | "auth"
    | "rate-limit"
    | "input-validation"
    | "pii-handling"
    | "cors"
    | "csp"
    | "other";
  description: string;
  severity: SpecSeverity;
}

// ── Main Spec Interface ───────────────────────────────────────────────────────

export interface FeatureSpec {
  /** Unique identifier — kebab-case, matches filename */
  id: string;

  /** Semver of this spec */
  version: string;

  /** Human-readable feature name */
  feature: string;

  /**
   * Module path relative to repo root.
   * For API routes:  app/api/auth/session/route.ts
   * For lib functions: lib/bot-detection.ts
   */
  module: string;

  /** One-paragraph description: what this does and why */
  description: string;

  /** For API endpoints only */
  api?: {
    path: string;
    method: HttpMethod;
    auth: boolean; // does this endpoint require authentication?
    rateLimit?: string; // e.g. "100 req/min per IP"
  };

  /** All inputs: function parameters or request fields */
  inputs: Parameter[];

  /** All return values / response shapes */
  outputs: ReturnValue[];

  /** Side effects (DB writes, emails, external calls) */
  sideEffects?: SideEffect[];

  /** All known error / failure modes */
  errorCases: ErrorCase[];

  /** Security and privacy requirements */
  securityRequirements?: SecurityRequirement[];

  /**
   * Acceptance criteria — each is a testable statement.
   * Format: "GIVEN <context> WHEN <action> THEN <expected result>"
   */
  acceptanceCriteria: string[];

  /** Concrete input/output examples for test generation */
  examples: TestExample[];

  /** Link to JIRA ticket or PRD */
  jiraTicket?: string;

  /** ISO date when spec was last updated */
  lastUpdated: string;

  /** Engineer who authored / last reviewed the spec */
  author?: string;
}
