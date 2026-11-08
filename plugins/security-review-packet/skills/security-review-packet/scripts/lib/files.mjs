// File listing, reading and redaction shared by the inventory scanners.
import { execFileSync } from 'node:child_process';
import { readdir, readFile, stat } from 'node:fs/promises';
import { join, relative, basename, sep } from 'node:path';

export const SKIP_DIRS = new Set([
  'node_modules', '.git', '.next', '.nuxt', '.svelte-kit', 'dist', 'build', 'out', '.vercel', '.netlify',
  '.amplify-hosting', '.terraform', 'venv', '.venv', 'env', '__pycache__', '.mypy_cache', '.pytest_cache',
  '.ruff_cache', '.tox', 'coverage', '.turbo', '.cache', 'site-packages', '.serverless', 'cdk.out', '.aws-sam',
  'vendor', 'target', '.idea', '.gradle', 'Pods',
]);
const MAX_BYTES = 1_000_000;
const MAX_FILES = 20_000;
const TEXT_EXT = /\.(m?[jt]sx?|c[jt]s|py|pyi|tf|tfvars|hcl|json|jsonc|ya?ml|toml|cfg|ini|txt|md|mdx|sql|prisma|graphql|gql|sh|bash|zsh|env|example|sample|template|lock)$/i;
const TEXT_NAMES = /^(dockerfile|makefile|procfile|pipfile|\.env.*|\.npmrc|\.gitignore|\.dockerignore|\.mcp\.json)$/i;
export const LOCKFILES = new Set(['package-lock.json', 'yarn.lock', 'pnpm-lock.yaml', 'poetry.lock', 'Pipfile.lock', 'uv.lock', 'bun.lockb']);
export const CODE_EXT = /\.(m?[jt]sx?|c[jt]s|py)$/i;

const isSkipped = (rel) => rel.split(/[\\/]/).some((seg) => SKIP_DIRS.has(seg));
const isText = (rel) => TEXT_EXT.test(rel) || TEXT_NAMES.test(basename(rel));

function git(root, args) {
  try {
    return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 * 1024 * 1024 });
  } catch {
    return null;
  }
}

async function walk(root, dir = root, out = []) {
  let entries;
  try { entries = await readdir(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    if (out.length >= MAX_FILES) break;
    const abs = join(dir, e.name);
    if (e.isDirectory()) {
      if (!SKIP_DIRS.has(e.name)) await walk(root, abs, out);
    } else if (e.isFile()) out.push(relative(root, abs).split(sep).join('/'));
  }
  return out;
}

// Lists the repo's files (tracked + untracked, minus .gitignore'd) and reads
// the text ones. Falls back to a directory walk outside git.
export async function loadRepo(root) {
  const listed = git(root, ['ls-files', '-co', '--exclude-standard', '-z']);
  const tracked = new Set((git(root, ['ls-files', '-z']) || '').split('\0').filter(Boolean));
  const all = (listed !== null ? listed.split('\0').filter(Boolean) : await walk(root)).filter((p) => !isSkipped(p));
  const files = [];
  let skippedLarge = 0;
  for (const rel of all.slice(0, MAX_FILES)) {
    if (!isText(rel)) continue;
    const abs = join(root, rel);
    let st;
    try { st = await stat(abs); } catch { continue; }
    if (!st.isFile()) continue;
    if (st.size > MAX_BYTES) { skippedLarge++; continue; }
    const text = await readFile(abs, 'utf8').catch(() => null);
    if (text === null || text.includes('\0')) continue;
    files.push({ path: rel, text, lines: text.split(/\r?\n/), test: isTestPath(rel) });
  }
  // .env files that git ignores still matter (names only): list them too.
  const ignoredEnv = [];
  try {
    for (const name of await readdir(root)) {
      if (/^\.env/.test(name) && !files.some((f) => f.path === name)) ignoredEnv.push(name);
    }
  } catch { /* ignore */ }
  const head = git(root, ['rev-parse', '--short', 'HEAD']);
  const branch = git(root, ['rev-parse', '--abbrev-ref', 'HEAD']);
  const dirty = git(root, ['status', '--porcelain']);
  return {
    files,
    allPaths: all,
    tracked,
    isGit: listed !== null,
    ignoredEnv,
    git: listed === null ? null : { commit: head?.trim() || null, branch: branch?.trim() || null, dirty: !!dirty?.trim() },
    truncated: all.length > MAX_FILES,
    skippedLarge,
  };
}

export function isTestPath(p) {
  return /(^|\/)(tests?|__tests__|spec|fixtures?|__mocks__|e2e|cypress)\//i.test(p) || /\.(test|spec)\.[a-z]+$/i.test(p) || /(^|\/)test_[^/]+\.py$/.test(p) || /_test\.py$/.test(p) || /(^|\/)test-[^/]+\.[cm]?[jt]sx?$/.test(p);
}

export const isCode = (f) => CODE_EXT.test(f.path);
export const isComment = (line) => /^\s*(\/\/|#|\*|\/\*|<!--)/.test(line);

// ---------- secrets ----------
export const SECRET_PATTERNS = [
  ['aws-access-key-id', /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/],
  ['private-key', /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ['anthropic-api-key', /\bsk-ant-[A-Za-z0-9_-]{20,}/],
  ['openai-api-key', /\bsk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{32,}/],
  ['stripe-live-key', /\b[sr]k_live_[A-Za-z0-9]{16,}/],
  ['github-token', /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,})/],
  ['slack-token', /\bxox[abprs]-[A-Za-z0-9-]{10,}/],
  ['google-api-key', /\bAIza[0-9A-Za-z_-]{35}\b/],
  ['huggingface-token', /\bhf_[A-Za-z0-9]{30,}/],
  ['jwt', /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/],
  ['url-with-password', /\b(?:postgres(?:ql)?|mysql|mariadb|mongodb(?:\+srv)?|redis|rediss|amqps?|https?):\/\/[^:\s"'`/@]+:[^@\s"'`]{3,}@/],
];
// Assignment of a string literal to a secret-looking name.
const ASSIGN = /\b([A-Za-z0-9_]*(?:api[_-]?key|secret|token|password|passwd|pwd|private[_-]?key|client[_-]?secret|access[_-]?key|auth[_-]?key)[A-Za-z0-9_]*)["']?\s*[:=]\s*["'`]([^"'`\s]{8,})["'`]/i;
const PLACEHOLDER = /(your|xxx|changeme|change-me|example|placeholder|dummy|replace|redacted|<|\$\{|\{\{|process\.env|os\.environ|getenv|\*\*\*|\.\.\.|test[_-]?key|fake|sample|todo|none|null)/i;

export function findSecrets(line) {
  const hits = [];
  for (const [kind, re] of SECRET_PATTERNS) {
    const m = line.match(re);
    if (m) hits.push({ kind, placeholder: PLACEHOLDER.test(m[0]) || /EXAMPLE/.test(m[0]) || /:(password|pass|secret|changeme)@/i.test(m[0]) });
  }
  if (!hits.length) {
    const m = line.match(ASSIGN);
    if (m && !PLACEHOLDER.test(m[2]) && !/^[A-Z0-9_]+$/.test(m[2]) && !/^(https?:\/\/[^:@\s]+$|\/|\.)/.test(m[2]) && !/(_URL|_URI|_ENDPOINT|_PATH|_HOST|_HEADER|_NAME|_FIELD|_PARAM|_TYPE|_KEY_ID|Url|Endpoint|Path|Name|Header)$/.test(m[1]) && /[0-9]/.test(m[2]) && /[A-Za-z]/.test(m[2])) {
      hits.push({ kind: 'hardcoded-credential', name: m[1], placeholder: false });
    }
  }
  return hits;
}

export function redact(line) {
  let out = line;
  for (const [kind, re] of SECRET_PATTERNS) out = out.replace(new RegExp(re.source, 'g'), `[redacted:${kind}]`);
  out = out.replace(new RegExp(ASSIGN.source, 'gi'), (all, name) => all.replace(/(["'`])[^"'`]*\1\s*$/, '"[redacted]"'));
  return out;
}

export function snippet(line, max = 140) {
  const s = redact(line.trim());
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

export function ref(file, lineIdx, extra = {}) {
  return { file: file.path, line: lineIdx + 1, snippet: snippet(file.lines[lineIdx] ?? ''), ...(file.test ? { test: true } : {}), ...extra };
}

// Keeps evidence lists short: the first `max` refs plus a count of the rest.
export function cap(list, max = 25) {
  if (list.length <= max) return list;
  const kept = list.slice(0, max);
  kept.push({ more: list.length - max });
  return kept;
}

export function lineOf(text, index) {
  let n = 0;
  for (let i = 0; i < index && i < text.length; i++) if (text.charCodeAt(i) === 10) n++;
  return n;
}
