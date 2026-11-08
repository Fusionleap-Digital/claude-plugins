// Loads the config, resolves suites (the user's copies first, then the
// built-in ones) and turns every case into one normalized shape.

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join, resolve, basename, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseYaml } from './yaml.mjs';
import { normalizeAssertion } from './assertions.mjs';

export const SKILL_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
export const BUILTIN_SUITES_DIR = join(SKILL_DIR, 'suites');
export const BUILTIN_SUITES = ['refusal-scope', 'prompt-injection', 'data-leakage', 'tool-misuse'];
const CONFIG_NAMES = ['evals.config.yaml', 'evals.config.yml', 'evals.config.json', 'evals/evals.config.yaml', 'evals/evals.config.yml', 'evals/evals.config.json'];

export function readData(file) {
  const text = readFileSync(file, 'utf8');
  return extname(file) === '.json' ? JSON.parse(text) : parseYaml(text, file);
}

export function findConfig(explicit) {
  if (explicit) {
    if (!existsSync(explicit)) throw new Error(`config not found: ${explicit}`);
    return resolve(explicit);
  }
  const hit = CONFIG_NAMES.map((n) => resolve(n)).find((p) => existsSync(p));
  if (!hit) throw new Error('no evals.config.yaml found here or in ./evals (run "evals.mjs init" to create one, or pass --config)');
  return hit;
}

export function loadConfig(path) {
  const config = readData(path) || {};
  config.baseDir = dirname(path);
  config.path = path;
  return config;
}

// Minimal glob: "*" and "?" in the last path segment only.
function expandGlob(baseDir, pattern) {
  const full = resolve(baseDir, pattern);
  if (!/[*?]/.test(basename(full))) return existsSync(full) ? [full] : [];
  const dir = dirname(full);
  if (!existsSync(dir)) return [];
  const re = new RegExp(`^${basename(full).replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`);
  return readdirSync(dir).filter((f) => re.test(f)).sort().map((f) => join(dir, f));
}

export function resolveSuiteFiles(config) {
  const entries = config.suites || ['correctness'];
  const out = [];
  for (const entry of entries) {
    const name = String(entry);
    if (/\.(ya?ml|json)$/.test(name)) {
      const files = expandGlob(config.baseDir, name);
      if (!files.length) throw new Error(`config: suite file not found: ${name}`);
      out.push(...files.map((file) => ({ file })));
    } else if (name === 'correctness') {
      const files = (Array.isArray(config.cases) ? config.cases : [config.cases || 'cases/*.yaml']).flatMap((p) => expandGlob(config.baseDir, p));
      if (!files.length) throw new Error('config: the correctness suite has no case files (set "cases:", for example cases/*.yaml)');
      out.push(...files.map((file) => ({ file, defaultSuite: 'correctness' })));
    } else {
      const local = ['yaml', 'yml', 'json'].map((x) => join(config.baseDir, 'suites', `${name}.${x}`)).find(existsSync);
      const builtin = join(BUILTIN_SUITES_DIR, `${name}.yaml`);
      if (local) out.push({ file: local });
      else if (existsSync(builtin)) out.push({ file: builtin, builtin: true });
      else throw new Error(`config: unknown suite "${name}" (built-in suites: ${BUILTIN_SUITES.join(', ')}; or give a file path)`);
    }
  }
  return out;
}

function interpolate(value, vars, missing) {
  if (typeof value === 'string') {
    return value.replace(/\{\{\s*(\w+)\s*\}\}/g, (m, k) => {
      if (k in vars) return String(vars[k]);
      missing.add(k);
      return m;
    });
  }
  if (Array.isArray(value)) return value.map((v) => interpolate(v, vars, missing));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [interpolate(k, vars, missing), interpolate(v, vars, missing)]));
  return value;
}

function normalizeContext(ctx, baseDir, where) {
  if (!ctx) return [];
  return (Array.isArray(ctx) ? ctx : [ctx]).map((d, i) => {
    if (typeof d === 'string') return { title: `document ${i + 1}`, content: d };
    if (d.file) return { title: d.title || basename(d.file), content: readFileSync(resolve(baseDir, d.file), 'utf8') };
    if (typeof d.content !== 'string') throw new Error(`${where}: context item ${i + 1} needs "content" or "file"`);
    return { title: d.title || `document ${i + 1}`, content: d.content };
  });
}

function normalizeMessages(c, where) {
  if (c.messages) {
    if (!Array.isArray(c.messages) || !c.messages.length) throw new Error(`${where}: "messages" must be a non-empty list`);
    const msgs = c.messages.map((m, i) => {
      if (!['user', 'assistant'].includes(m.role)) throw new Error(`${where}: message ${i + 1} role must be user or assistant`);
      return { role: m.role, content: String(m.content ?? '') };
    });
    if (msgs[msgs.length - 1].role !== 'user') throw new Error(`${where}: the last message must be from the user`);
    return msgs;
  }
  if (c.input === undefined || c.input === null) throw new Error(`${where}: needs "input" or "messages"`);
  return [{ role: 'user', content: String(c.input) }];
}

export function loadSuites(config, { warn = () => {} } = {}) {
  const suites = new Map();
  for (const { file, defaultSuite, builtin } of resolveSuiteFiles(config)) {
    const raw = readData(file);
    const doc = Array.isArray(raw) ? { cases: raw } : raw || {};
    const name = doc.suite || defaultSuite || basename(file).replace(/\.(ya?ml|json)$/, '');
    const vars = { ...(doc.vars || {}), ...(config.vars || {}) };
    const missing = new Set();
    const cases = interpolate(doc.cases || [], vars, missing);
    const defaults = interpolate(doc.defaults || {}, vars, missing);
    if (missing.size) warn(`${basename(file)}: no value for ${[...missing].map((m) => `{{${m}}}`).join(', ')} (set it under "vars:" in the config)`);
    const suite = suites.get(name) || { name, description: doc.description || '', files: [], builtin: Boolean(builtin), cases: [] };
    suite.files.push(file);
    cases.forEach((c, i) => {
      const id = String(c.id || `case-${i + 1}`);
      const where = `${basename(file)} case "${id}"`;
      if (suite.cases.some((x) => x.id === id)) throw new Error(`${where}: duplicate case id in suite ${name}`);
      const asserts = [...(defaults.assert || []), ...(c.assert || [])].map((a, j) => normalizeAssertion(a, `${where} assertion ${j + 1}`));
      if (!asserts.length) throw new Error(`${where}: no assertions`);
      const norm = {
        suite: name,
        id,
        description: c.description || '',
        messages: normalizeMessages(c, where),
        context: normalizeContext(c.context, dirname(file), where),
        tool_mocks: c.tool_mocks || {},
        tools: c.tools || defaults.tools || [],
        seeded: (c.seeded || []).map(String),
        repeats: Number(c.repeats ?? defaults.repeats ?? 0) || null,
        min_pass_rate: Number(c.min_pass_rate ?? defaults.min_pass_rate ?? config.min_pass_rate ?? 1),
        tags: c.tags || [],
        assert: asserts,
      };
      for (const a of norm.assert) if (a.type === 'no-leak') a.seeded_count = (a.seeded ?? norm.seeded).length;
      // Fingerprint of everything that defines the test, so compare can tell
      // when a case (or its expected result) changed between two runs.
      norm.hash = createHash('sha256').update(JSON.stringify({ ...norm, hash: undefined })).digest('hex').slice(0, 12);
      suite.cases.push(norm);
    });
    suites.set(name, suite);
  }
  return [...suites.values()];
}
