// Line-level scanners over source files: providers, models, data stores,
// vendors, outbound hosts, data handling, env vars and control signals.
import { PROVIDERS, MODEL_ID, DATASTORES, VENDORS, SECRET_MANAGERS, CONTROLS, DATA_TERMS } from './rules.mjs';
import { isCode, isComment, ref, cap, findSecrets, LOCKFILES } from './files.mjs';

const CONFIG_EXT = /\.(json|ya?ml|toml|tf|env|example|sample)$/i;
const scannable = (f) => !LOCKFILES.has(f.path.split('/').pop()) && (isCode(f) || CONFIG_EXT.test(f.path) || /(^|\/)\.env/.test(f.path));
const isEnvFile = (p) => /(^|\/)\.env(\.|$)/.test(p) || /\.env\.(example|sample|template)$/.test(p);

// Generic matcher for rule lists with `deps` and `code` patterns.
function matchRules(rules, files, depNames, { max = 15 } = {}) {
  const out = [];
  for (const rule of rules) {
    const viaDeps = rule.deps.filter((d) => depNames.has(d));
    const refs = [];
    // Direct REST calls count too (fetch('https://api.anthropic.com/...')).
    const patterns = [...rule.code, ...(rule.hosts || []).filter((h) => !/[<*]/.test(h)).map((h) => new RegExp(h.replace(/[.]/g, '\\.')))];
    for (const f of files) {
      if (!isCode(f) && !/\.(tf|ya?ml|toml)$/.test(f.path)) continue;
      f.lines.forEach((line, i) => {
        if (line.length > 400 || isComment(line)) return;
        if (patterns.some((re) => re.test(line))) refs.push(ref(f, i));
      });
    }
    if (!viaDeps.length && !refs.length) continue;
    const { code, deps, ...meta } = rule;
    out.push({ ...meta, dependencies: viaDeps, evidence: cap(refs, max), confidence: refs.some((r) => !r.test) ? 'code' : viaDeps.length ? 'dependency-only' : 'test-only' });
  }
  return out;
}

export function scanModels(files) {
  const byId = new Map();
  for (const f of files.filter(scannable)) {
    f.lines.forEach((line, i) => {
      if (line.length > 400) return;
      for (const m of line.matchAll(MODEL_ID)) {
        const id = m[1];
        if (!byId.has(id)) byId.set(id, []);
        byId.get(id).push(ref(f, i));
      }
    });
  }
  return [...byId.entries()].map(([id, refs]) => ({ id, family: modelFamily(id), refs: cap(refs, 10) }));
}

function modelFamily(id) {
  if (/claude/.test(id)) return /^(us\.|eu\.|apac\.|global\.)?anthropic\./.test(id) ? 'anthropic-via-bedrock' : 'anthropic';
  if (/^(gpt|o[1-9]|chatgpt|text-embedding-3|text-embedding-ada|dall-e|whisper|tts|gpt-image)/.test(id)) return 'openai';
  if (/gemini|gecko|text-embedding-00/.test(id)) return 'google';
  if (/^amazon\./.test(id)) return 'amazon-bedrock';
  if (/^(cohere\.|command|embed-)/.test(id)) return 'cohere';
  if (/mistral|codestral/.test(id)) return 'mistral';
  if (/llama|qwen|deepseek|bge|MiniLM|mpnet|nomic/.test(id)) return 'open-weights';
  if (/voyage/.test(id)) return 'voyage';
  if (/grok/.test(id)) return 'xai';
  return 'unknown';
}

export function scanProviders(files, depNames, envNames) {
  const found = matchRules(PROVIDERS, files, depNames);
  for (const p of found) {
    const rule = PROVIDERS.find((r) => r.id === p.id);
    p.envVars = [...envNames].filter((n) => rule.env.source !== '^$' && rule.env.test(n));
  }
  // Env-only matches (e.g. OPENAI_API_KEY set but no SDK found).
  for (const rule of PROVIDERS) {
    if (found.some((p) => p.id === rule.id) || rule.env.source === '^$') continue;
    const envVars = [...envNames].filter((n) => rule.env.test(n));
    if (envVars.length) {
      const { code, deps, env, ...meta } = rule;
      found.push({ ...meta, dependencies: [], evidence: [], envVars, confidence: 'env-var-only' });
    }
  }
  for (const p of found) delete p.env;
  return found;
}

export const scanDatastores = (files, depNames) => matchRules(DATASTORES, files, depNames);
export const scanVendors = (files, depNames) => matchRules(VENDORS, files, depNames);
export const scanSecretManagers = (files, depNames) => matchRules(SECRET_MANAGERS, files, depNames);

const IGNORE_HOSTS = /(^|\.)(w3\.org|schema\.org|json-schema\.org|example\.(com|org|net)|localhost|xmlns\.com|purl\.org|ogp\.me|schemas\.(microsoft|openxmlformats)\.com|reactjs\.org|nextjs\.org|npmjs\.(com|org)|python\.org|mozilla\.org|creativecommons\.org|opensource\.org|spdx\.org|apache\.org)$/;
const CALL = /\b(fetch|axios(\.\w+)?|got|ky|request|requests\.\w+|httpx\.\w+|urlopen|aiohttp|http\.get|https\.get|new URL|new WebSocket|EventSource|baseURL|base_url|endpoint|webhook)\b/i;
const DYNAMIC_CALL = /\b(fetch|axios\.(get|post|put|request)|got|requests\.(get|post|put|request)|httpx\.(get|post|request|AsyncClient\(\)\.get)|urlopen)\(\s*(?!["'`]https?:)([A-Za-z_][\w.[\]]*|`[^`]*\$\{)/;

export function scanHosts(files, providers) {
  const hosts = new Map();
  const dynamicCalls = [];
  for (const f of files) {
    if (!isCode(f) && !/\.(tf|ya?ml|toml|json)$/.test(f.path)) continue;
    if (LOCKFILES.has(f.path.split('/').pop()) || f.path.endsWith('package.json')) continue;
    f.lines.forEach((line, i) => {
      if (line.length > 500) return;
      for (const m of line.matchAll(/\b(?:https?|wss?):\/\/([a-z0-9][a-z0-9.-]*\.[a-z]{2,}|\d{1,3}(?:\.\d{1,3}){3})(?::\d+)?/gi)) {
        const host = m[1].toLowerCase();
        if (IGNORE_HOSTS.test(host) || /^127\.|^0\.0\.0\.0/.test(host)) continue;
        if (!hosts.has(host)) hosts.set(host, []);
        hosts.get(host).push(ref(f, i, { call: CALL.test(line) || undefined, comment: isComment(line) || undefined }));
      }
      if (isCode(f) && DYNAMIC_CALL.test(line) && !isComment(line)) dynamicCalls.push(ref(f, i));
    });
  }
  const list = [...hosts.entries()].map(([host, refs]) => ({
    host, source: 'literal',
    called: refs.some((r) => r.call && !r.comment && !r.test),
    testOnly: refs.every((r) => r.test) || undefined,
    refs: cap([...refs.filter((r) => !r.test), ...refs.filter((r) => r.test)], 10),
  }));
  for (const p of providers.filter((x) => x.confidence !== 'env-var-only')) {
    for (const h of p.hosts || []) if (!list.some((x) => x.host === h)) list.push({ host: h, source: `sdk-default (${p.id})`, refs: [] });
  }
  list.sort((a, b) => (b.called ? 1 : 0) - (a.called ? 1 : 0) || (a.source === 'literal' ? 0 : 1) - (b.source === 'literal' ? 0 : 1) || a.host.localeCompare(b.host));
  return { hosts: list, dynamicCalls: cap(dynamicCalls, 30) };
}

const LOG_CALL = /\b(console\.(log|info|debug|warn|error)|logger\.\w+|log\.(info|debug|warn|error|trace)|logging\.(info|debug|warning|error|exception)|print)\s*\(/;
const PROMPTISH = /\b(prompt|messages|completion|question|answer|user_?[iI]nput|transcript|conversation|chat_?[hH]istory|output_text|summary|reply|response\.(content|text|output))\b/;
const DB_WRITE = /(\.insert\w*\(|\.create\(|\.createMany\(|\.upsert\(|\.save\(|INSERT\s+INTO|put_item|PutItemCommand|PutCommand|session\.add\(|\.add\(|collection\(.*\)\.(add|set)\(|\.set\()/i;
const CONVO = /(message|conversation|chat|prompt|completion|transcript|history|thread)/i;
const EMBED = /(embeddings\.create|\.embed(Query|Documents|Many|Content)?\(|embed_(documents|query)|embedMany\(|embed\(|get_text_embedding|encode\(\s*(texts|docs|chunks|sentences)|titan-embed|text-embedding)/;
const VECTOR_WRITE = /(\.upsert\(|add_documents|addDocuments|from_documents|fromDocuments|from_texts|fromTexts|\.add\(\s*\{?\s*(ids|documents|embeddings|vectors)|INSERT\s+INTO\s+\w*(chunk|embedding|document|vector)\w*)/i;
const FILE_STORE = /(PutObjectCommand|put_object|upload_file|upload_fileobj|\.upload\(|uploadData\(|createWriteStream|writeFile\(|bucket\.file\(|\.upload_blob\()/;

export function scanDataHandling(files) {
  const out = { promptLogging: [], conversationStorage: [], embeddingCalls: [], vectorWrites: [], fileStorage: [] };
  for (const f of files.filter(isCode)) {
    const vectorFile = /vector|embedding|pinecone|qdrant|chroma|weaviate|pgvector|milvus|lancedb|upstash\/vector|turbopuffer/i.test(f.text);
    f.lines.forEach((line, i) => {
      if (line.length > 400 || isComment(line)) return;
      if (LOG_CALL.test(line) && PROMPTISH.test(line)) out.promptLogging.push(ref(f, i));
      if (DB_WRITE.test(line) && CONVO.test(line) && !/\.(add|set)\(\s*['"`]?(Header|header|cookie)/.test(line)) out.conversationStorage.push(ref(f, i));
      if (EMBED.test(line)) out.embeddingCalls.push(ref(f, i));
      if (vectorFile && VECTOR_WRITE.test(line)) out.vectorWrites.push(ref(f, i));
      if (FILE_STORE.test(line)) out.fileStorage.push(ref(f, i));
    });
  }
  for (const k of Object.keys(out)) out[k] = cap(out[k], 20);
  return out;
}

export function scanDataTerms(files) {
  const out = {};
  for (const [cat, re] of Object.entries(DATA_TERMS)) {
    const refs = [];
    for (const f of files) {
      if (!isCode(f) && !/\.(sql|prisma|graphql|gql)$/.test(f.path)) continue;
      f.lines.forEach((line, i) => { if (line.length < 300 && re.test(line)) refs.push(ref(f, i)); });
    }
    const terms = {};
    for (const r of refs) { const t = (r.snippet.match(re)?.[0] || '').toLowerCase().replace(/[_ ]+/g, ' ').trim(); if (t) terms[t] = (terms[t] || 0) + 1; }
    out[cat] = { hits: refs.length, terms, refs: cap(refs, 10) };
  }
  return out;
}

const ENV_REF = [
  /process\.env\.([A-Z_][A-Z0-9_]*)/g,
  /process\.env\[\s*['"]([A-Z_][A-Z0-9_]*)['"]\s*\]/g,
  /import\.meta\.env\.([A-Z_][A-Z0-9_]*)/g,
  /Deno\.env\.get\(\s*['"]([A-Z_][A-Z0-9_]*)['"]/g,
  /os\.environ\[\s*['"]([A-Z_][A-Z0-9_]*)['"]\s*\]/g,
  /os\.environ\.get\(\s*['"]([A-Z_][A-Z0-9_]*)['"]/g,
  /os\.getenv\(\s*['"]([A-Z_][A-Z0-9_]*)['"]/g,
  /\bsecret\(\s*['"]([A-Z_][A-Z0-9_]*)['"]\s*\)/g,
  /\$\{\{\s*secrets\.([A-Z_][A-Z0-9_]*)\s*\}\}/g,
  /\benv\(\s*['"]([A-Z_][A-Z0-9_]*)['"]/g,
];
const SECRETISH = /(KEY|SECRET|TOKEN|PASSWORD|PASSWD|PWD|PRIVATE|CREDENTIAL|CREDS|DSN|CONNECTION_STRING|DATABASE_URL|_URI$|^DB_URL$|REDIS_URL|MONGO(DB)?_URL)/;
const NOT_SECRET = /(PUBLIC_KEY|PUBLISHABLE|_KEY_ID$|KEY_NAME|ANON_KEY|SITE_KEY|_REGION$|_URL$(?<!DATABASE_URL|REDIS_URL|MONGO_URL|MONGODB_URL|DB_URL)|TOKEN_URL|AUTH_URL|AUTH_TRUST_HOST|_ENABLED$|_ID$(?<!CLIENT_ID))/;
const PUBLIC_PREFIX = /^(NEXT_PUBLIC_|VITE_|REACT_APP_|PUBLIC_|EXPO_PUBLIC_|NUXT_PUBLIC_|GATSBY_)/;

export function scanEnv(files, repo) {
  const vars = new Map();
  const get = (name) => {
    if (!vars.has(name)) {
      const secretLike = SECRETISH.test(name) && !NOT_SECRET.test(name);
      vars.set(name, { name, secretLike, browserExposed: PUBLIC_PREFIX.test(name), refs: [], definedIn: [] });
    }
    return vars.get(name);
  };
  const envFiles = [];
  const hardcoded = [];
  for (const f of files) {
    if (isEnvFile(f.path)) {
      const names = [];
      f.lines.forEach((line, i) => {
        const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
        if (!m) return;
        names.push(m[1]);
        const v = get(m[1]);
        v.definedIn.push(`${f.path}:${i + 1}`);
        const value = m[2].replace(/^["']|["']$/g, '').trim();
        if (value) v.hasValueIn = [...(v.hasValueIn || []), f.path];
      });
      const template = /\.(example|sample|template)$/.test(f.path);
      const withValues = names.filter((n) => vars.get(n).hasValueIn?.includes(f.path) && vars.get(n).secretLike);
      envFiles.push({ path: f.path, tracked: repo.tracked.has(f.path), template, names, secretNamesWithValues: template ? undefined : withValues });
      continue;
    }
    if (!scannable(f)) continue;
    f.lines.forEach((line, i) => {
      if (line.length > 500) return;
      for (const re of ENV_REF) for (const m of line.matchAll(re)) get(m[1]).refs.push(`${f.path}:${i + 1}`);
      for (const s of findSecrets(line)) hardcoded.push({ kind: s.kind, file: f.path, line: i + 1, placeholder: s.placeholder || undefined, test: f.test || undefined, name: s.name });
    });
  }
  for (const name of repo.ignoredEnv) envFiles.push({ path: name, tracked: false, ignored: true, names: [], note: 'present on disk, ignored by git; contents not read' });
  const list = [...vars.values()].map((v) => ({ ...v, refs: v.refs.slice(0, 8), refCount: v.refs.length, hasValueIn: undefined }))
    .sort((a, b) => a.name.localeCompare(b.name));
  return { vars: list, envFiles, hardcodedSecrets: hardcoded };
}

export function scanControls(files) {
  const out = {};
  for (const [cat, patterns] of Object.entries(CONTROLS)) {
    const refs = [];
    for (const f of files) {
      if (!isCode(f) && !/\.(tf|ya?ml|sql|json)$/.test(f.path)) continue;
      if (LOCKFILES.has(f.path.split('/').pop()) || f.path.endsWith('package.json')) continue;
      f.lines.forEach((line, i) => { if (line.length < 400 && !isComment(line) && patterns.some((re) => re.test(line))) refs.push(ref(f, i)); });
    }
    out[cat] = cap(refs, 15);
  }
  return out;
}
