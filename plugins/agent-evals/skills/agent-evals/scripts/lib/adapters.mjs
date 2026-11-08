// Target adapters: how a test case reaches the system under test.
// Every adapter takes the canonical request and returns
//   { output, tool_calls: [{ name, args }], cost_usd, usage, error }
// The harness measures latency itself.
//
// Canonical request (what http bodies and command stdin are built from):
//   { case_id, repeat, input, messages: [{ role, content }],
//     context: [{ title, content }], tool_mocks, tools, vars }

import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadAnthropic, costFor } from './anthropic.mjs';

export function makeAdapter(target, baseDir) {
  if (!target || !target.type) throw new Error('config: target.type is required (http, command or anthropic)');
  if (target.type === 'http') return (req) => httpAdapter(target, req);
  if (target.type === 'command') return (req) => commandAdapter(target, req, baseDir);
  if (target.type === 'anthropic') return anthropicAdapter(target, baseDir);
  throw new Error(`config: unknown target.type "${target.type}"`);
}

export function describeTarget(target) {
  if (target.type === 'http') return `http ${target.method || 'POST'} ${target.url}`;
  if (target.type === 'command') return `command \`${target.command}\``;
  if (target.type === 'anthropic') return `anthropic ${target.model || 'claude-opus-5-5'}`;
  return target.type;
}

// ---------- mapping helpers ----------

// Dot path lookup: "choices.0.message.content". "" or "." means the whole value.
export function getPath(obj, path) {
  if (path === undefined || path === null || path === '' || path === '.') return obj;
  return String(path).replace(/^\$\.?/, '').split('.').filter(Boolean)
    .reduce((v, k) => (v === undefined || v === null ? undefined : v[k]), obj);
}

// Fill a request template. A string that is exactly "{{name}}" becomes the
// raw value (object, array, number); otherwise {{name}} is interpolated as text.
export function fillTemplate(tpl, req) {
  if (typeof tpl === 'string') {
    const whole = tpl.match(/^\{\{\s*([\w.]+)\s*\}\}$/);
    if (whole) return getPath(req, whole[1]);
    return tpl.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_, k) => {
      const v = getPath(req, k);
      return v === undefined || v === null ? '' : typeof v === 'string' ? v : JSON.stringify(v);
    });
  }
  if (Array.isArray(tpl)) return tpl.map((t) => fillTemplate(t, req));
  if (tpl && typeof tpl === 'object') return Object.fromEntries(Object.entries(tpl).map(([k, v]) => [k, fillTemplate(v, req)]));
  return tpl;
}

function normalizeToolCalls(raw, map = {}) {
  if (!Array.isArray(raw)) return [];
  return raw.map((c) => {
    const name = getPath(c, map.name || 'name') ?? getPath(c, 'function.name');
    let args = getPath(c, map.args || 'args') ?? getPath(c, 'arguments') ?? getPath(c, 'input') ?? getPath(c, 'function.arguments');
    if (typeof args === 'string') { try { args = JSON.parse(args); } catch { /* keep string */ } }
    return { name: String(name ?? ''), args: args ?? {} };
  });
}

function mapResponse(body, res = {}) {
  if (typeof body === 'string') return { output: body, tool_calls: [] };
  const output = getPath(body, res.output ?? 'output');
  return {
    output: typeof output === 'string' ? output : output === undefined ? '' : JSON.stringify(output),
    tool_calls: normalizeToolCalls(getPath(body, res.tool_calls ?? 'tool_calls'), res.tool_call || {}),
    cost_usd: numberOrNull(getPath(body, res.cost_usd ?? 'cost_usd')),
  };
}

const numberOrNull = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

function expandEnv(s) {
  // ${VAR} in headers and URLs, so tokens stay out of the config file.
  return typeof s === 'string' ? s.replace(/\$\{(\w+)\}/g, (_, k) => process.env[k] ?? '') : s;
}

// ---------- http ----------

async function httpAdapter(t, req) {
  if (!t.url) throw new Error('config: target.url is required for http targets');
  const body = fillTemplate(t.request ?? '{{.}}', { ...req, '.': req });
  const headers = { 'content-type': 'application/json', ...Object.fromEntries(Object.entries(t.headers || {}).map(([k, v]) => [k, expandEnv(v)])) };
  let res;
  try {
    res = await fetch(expandEnv(t.url), {
      method: t.method || 'POST',
      headers,
      body: typeof body === 'string' ? body : JSON.stringify(body ?? req),
      signal: AbortSignal.timeout((t.timeout_s || 60) * 1000),
    });
  } catch (err) {
    return { output: '', tool_calls: [], error: `request failed: ${err?.cause?.code || err?.name || err}` };
  }
  const text = await res.text();
  if (!res.ok) return { output: text.slice(0, 2000), tool_calls: [], error: `HTTP ${res.status}` };
  let parsed = text;
  try { parsed = JSON.parse(text); } catch { /* plain text response */ }
  return mapResponse(parsed, t.response);
}

// ---------- command ----------

function commandAdapter(t, req, baseDir) {
  if (!t.command) throw new Error('config: target.command is required for command targets');
  return new Promise((done) => {
    const child = spawn(t.command, {
      shell: true,
      cwd: t.cwd ? resolve(baseDir, t.cwd) : baseDir,
      env: { ...process.env, ...(t.env || {}) },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), (t.timeout_s || 60) * 1000);
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', (e) => { clearTimeout(timer); done({ output: '', tool_calls: [], error: `could not start: ${e.message}` }); });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      if (signal) return done({ output: out, tool_calls: [], error: `killed (${signal}); timeout is ${t.timeout_s || 60}s` });
      if (code !== 0) return done({ output: out, tool_calls: [], error: `exit code ${code}: ${err.trim().slice(0, 500)}` });
      const trimmed = out.trim();
      if (t.output === 'text') return done({ output: trimmed, tool_calls: [] });
      try {
        const parsed = JSON.parse(trimmed);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return done(mapResponse(parsed, t.response));
      } catch { /* not JSON: treat stdout as the answer */ }
      done({ output: trimmed, tool_calls: [] });
    });
    const stdin = t.stdin === 'input' ? req.input : JSON.stringify(req);
    child.stdin.on('error', () => {});
    child.stdin.end(stdin);
  });
}

// ---------- anthropic (prompt-only apps) ----------

function readMaybe(baseDir, file) {
  return file ? readFileSync(resolve(baseDir, file), 'utf8') : undefined;
}

function contextBlock(context) {
  if (!context?.length) return '';
  const docs = context.map((d, i) => `<document index="${i + 1}"${d.title ? ` title="${String(d.title).replace(/"/g, "'")}"` : ''}>\n${d.content}\n</document>`);
  return `<documents>\n${docs.join('\n')}\n</documents>\n\n`;
}

function anthropicAdapter(t, baseDir) {
  const model = t.model || 'claude-opus-5-5';
  const system = t.system ?? readMaybe(baseDir, t.system_file);
  const baseTools = t.tools ?? (t.tools_file ? JSON.parse(readMaybe(baseDir, t.tools_file)) : []);
  const maxTurns = t.max_turns || 6;

  return async (req) => {
    const sdk = await loadAnthropic();
    if (!sdk.ok) return { output: '', tool_calls: [], error: sdk.reason };
    const client = sdk.client;
    const tools = [...baseTools];
    for (const tool of req.tools || []) if (!tools.some((x) => x.name === tool.name)) tools.push(tool);

    // Retrieved documents go in front of the last user turn, as a RAG app would.
    const messages = req.messages.map((m) => ({ role: m.role, content: m.content }));
    const lastUser = messages.map((m) => m.role).lastIndexOf('user');
    if (req.context?.length && lastUser >= 0) messages[lastUser].content = contextBlock(req.context) + messages[lastUser].content;

    const mockQueue = Object.fromEntries(Object.entries(req.tool_mocks || {}).map(([k, v]) => [k, Array.isArray(v) ? [...v] : [v]]));
    const toolCalls = [];
    const texts = [];
    const usage = { input_tokens: 0, output_tokens: 0 };
    let cost = 0;

    for (let turn = 0; turn < maxTurns; turn++) {
      const params = {
        model,
        max_tokens: t.max_tokens || 16000,
        messages,
        ...(system ? { system } : {}),
        ...(tools.length ? { tools } : {}),
        ...(t.effort ? { output_config: { effort: t.effort } } : {}),
      };
      let res;
      try {
        res = t.fallbacks
          ? await client.beta.messages.create({ ...params, betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' })
          : await client.messages.create(params);
      } catch (err) {
        return { output: texts.join('\n'), tool_calls: toolCalls, usage, cost_usd: cost, error: sdk.describeError(err) };
      }
      usage.input_tokens += res.usage?.input_tokens || 0;
      usage.output_tokens += res.usage?.output_tokens || 0;
      cost += costFor(res.model || model, res.usage, t.pricing);
      for (const b of res.content) if (b.type === 'text') texts.push(b.text);
      if (res.stop_reason === 'refusal') {
        return { output: texts.join('\n'), tool_calls: toolCalls, usage, cost_usd: cost, refusal: res.stop_details?.category || true };
      }
      const uses = res.content.filter((b) => b.type === 'tool_use');
      if (res.stop_reason !== 'tool_use' || !uses.length) break;
      messages.push({ role: 'assistant', content: res.content });
      const results = uses.map((u) => {
        toolCalls.push({ name: u.name, args: u.input });
        const q = mockQueue[u.name];
        const mock = q && q.length ? (q.length > 1 ? q.shift() : q[0]) : t.default_tool_result ?? 'No result configured for this tool in the test case.';
        return { type: 'tool_result', tool_use_id: u.id, content: typeof mock === 'string' ? mock : JSON.stringify(mock) };
      });
      messages.push({ role: 'user', content: results });
    }
    return { output: texts.join('\n'), tool_calls: toolCalls, usage, cost_usd: cost };
  };
}
