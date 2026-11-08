/**
 * FusionLeap — Example Spec: Auth Session
 *
 * Machine-readable specification for the GET /api/auth/session endpoint.
 * Used by Claude AI to generate unit tests, JSDoc, and code boilerplate.
 *
 * Author: FusionLeap Digital
 * JIRA: WYS-101
 */

import type { FeatureSpec } from "./spec.schema";

const spec: FeatureSpec = {
  id: "auth-session",
  version: "1.0.0",
  feature: "Auth — Get Current Session",
  module: "app/api/auth/session/route.ts",
  description: `
    Returns the current authenticated user's session information in a format
    compatible with NextAuth. Reads the 'app-auth' HttpOnly cookie, validates
    it against the session store, and returns the user object if the session is
    live. Returns { user: null } (not a 401) when no session exists, to simplify
    client-side unauthenticated state handling.
  `.trim(),

  stack: ["Next.js App Router", "TypeScript strict", "MongoDB", "Vitest"],

  api: {
    path: "/api/auth/session",
    method: "GET",
    auth: false, // endpoint is public but returns null user when unauthenticated
    rateLimit: "200 req/min per IP",
  },

  inputs: [
    {
      name: "app-auth (cookie)",
      type: "string",
      required: false,
      description:
        "HttpOnly session token cookie. Set by POST /api/auth/login.",
      sensitive: true,
      example: "sess_abc123xyz",
    },
  ],

  outputs: [
    {
      type: "{ user: { email: string; id: string }; expires: string }",
      description:
        "Authenticated session — user object with expiry ISO timestamp.",
      httpStatus: 200,
      example: {
        user: { email: "user@example.com", id: "user_abc123" },
        expires: "2025-04-01T00:00:00.000Z",
      },
    },
    {
      type: "{ user: null }",
      description: "No active session — cookie missing or session expired.",
      httpStatus: 200,
      example: { user: null },
    },
    {
      type: "{ error: string }",
      description: "Unexpected server error fetching session from DB.",
      httpStatus: 500,
      example: { error: "Failed to fetch session" },
    },
  ],

  sideEffects: [
    {
      type: "database_read",
      description:
        "Calls getSession(token) which reads from the sessions collection in MongoDB.",
      collection: "sessions",
    },
    {
      type: "log",
      description: "Logs error to console.error on unexpected DB failure.",
    },
  ],

  errorCases: [
    {
      code: "NO_COOKIE",
      condition: "Request has no 'app-auth' cookie",
      httpStatus: 200,
      response: { user: null },
    },
    {
      code: "SESSION_NOT_FOUND",
      condition:
        "Cookie present but session not found in DB (expired or deleted)",
      httpStatus: 200,
      response: { user: null },
    },
    {
      code: "DB_ERROR",
      condition: "MongoDB query throws an unexpected error",
      httpStatus: 500,
      response: { error: "Failed to fetch session" },
    },
  ],

  securityRequirements: [
    {
      type: "pii-handling",
      description:
        "Response must NEVER include password hash, raw token, or internal session ID.",
      severity: "critical",
    },
    {
      type: "pii-handling",
      description:
        "Session token is read from HttpOnly cookie — never returned in response body.",
      severity: "high",
    },
    {
      type: "auth",
      description:
        "Returns HTTP 200 (not 401) for unauthenticated requests to avoid leaking auth status " +
        "via status codes in open telemetry or proxy logs.",
      severity: "medium",
    },
  ],

  acceptanceCriteria: [
    "GIVEN a request with a valid app-auth cookie WHEN the session exists in DB THEN return 200 with user.email and user.id",
    "GIVEN a request with a valid app-auth cookie WHEN the session has expired THEN return 200 with user: null",
    "GIVEN a request with NO app-auth cookie WHEN the endpoint is called THEN return 200 with user: null",
    "GIVEN any request WHEN the response is successful THEN the password hash must NOT appear in the response body",
    "GIVEN any request WHEN MongoDB throws THEN return 500 with { error: 'Failed to fetch session' }",
    "GIVEN a valid session WHEN expires is not set on the session document THEN default to now + 7 days",
  ],

  examples: [
    {
      description: "Happy path — valid cookie, live session",
      input: { cookie: "sess_valid123" },
      expectedOutput: {
        user: { email: "user@example.com", id: "user_abc" },
        expires: "2025-04-01T00:00:00.000Z",
      },
      tags: ["happy-path"],
    },
    {
      description: "No cookie sent",
      input: { cookie: null },
      expectedOutput: { user: null },
      tags: ["happy-path", "unauthenticated"],
    },
    {
      description: "Cookie present but session expired / not in DB",
      input: { cookie: "sess_expired999" },
      expectedOutput: { user: null },
      tags: ["edge-case"],
    },
    {
      description: "MongoDB throws during getSession call",
      input: { cookie: "sess_db_error" },
      expectedOutput: { error: "Failed to fetch session" },
      expectedError: "DB_ERROR",
      tags: ["error-case"],
    },
  ],

  jiraTicket: "WYS-101",
  lastUpdated: "2025-03-14",
  author: "fusionleap-digital",
};

export default spec;
