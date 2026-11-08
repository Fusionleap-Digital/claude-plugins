// Assertions. Everything here is deterministic except `rubric`, which asks a
// model and is labeled graded. `refuses` / `not-refuses` are deterministic but
// phrase-based, so they are labeled heuristic.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { validate } from './jsonschema.mjs';
import { findSensitive, findSeeded, DEFAULT_DETECTORS, mask } from './detectors.mjs';
import { gradeRubric } from './judge.mjs';

export const TYPES = ['contains', 'not-contains', 'regex', 'not-regex', 'json-schema', 'tool-called', 'tool-not-called', 'max-latency', 'max-cost', 'refuses', 'not-refuses', 'no-leak', 'rubric'];

const SHORTHAND = {
  contains: (v) => ({ value: v }),
  'not-contains': (v) => ({ value: v }),
  regex: (v) => (typeof v === 'string' ? { pattern: v } : v),
  'not-regex': (v) => (typeof v === 'string' ? { pattern: v } : v),
  'json-schema': (v) => ({ schema: v }),
  'tool-called': (v) => (typeof v === 'string' ? { name: v } : v),
  'tool-not-called': (v) => ({ name: v }),
  'max-latency': (v) => ({ ms: v }),
  'max-cost': (v) => ({ usd: v }),
  refuses: (v) => (v && typeof v === 'object' ? v : {}),
  'not-refuses': (v) => (v && typeof v === 'object' ? v : {}),
  'no-leak': (v) => (v && typeof v === 'object' ? v : {}),
  rubric: (v) => (typeof v === 'string' ? { criteria: v } : v),
};

export function normalizeAssertion(spec, where) {
  if (spec && typeof spec === 'object' && spec.type) {
    if (!TYPES.includes(spec.type)) throw new Error(`${where}: unknown assertion type "${spec.type}"`);
    return { ...spec };
  }
  const keys = spec && typeof spec === 'object' ? Object.keys(spec) : [];
  const type = keys.find((k) => TYPES.includes(k));
  if (!type) throw new Error(`${where}: can't read assertion ${JSON.stringify(spec)} (known types: ${TYPES.join(', ')})`);
  const extra = Object.fromEntries(keys.filter((k) => k !== type).map((k) => [k, spec[k]]));
  return { type, ...SHORTHAND[type](spec[type]), ...extra };
}

export function describeAssertion(a) {
  switch (a.type) {
    case 'contains': case 'not-contains': return `${a.type} ${JSON.stringify(a.value)}`;
    case 'regex': case 'not-regex': return `${a.type} /${a.pattern}/${a.flags ?? 'i'}`;
    case 'json-schema': return `json-schema${a.schema_file ? ` ${a.schema_file}` : ''}`;
    case 'tool-called': return `tool-called ${a.name}${a.args ? ` with ${JSON.stringify(a.args)}` : ''}${a.times !== undefined ? ` ×${a.times}` : ''}`;
    case 'tool-not-called': return `tool-not-called ${Array.isArray(a.name) ? a.name.join(', ') : a.name}`;
    case 'max-latency': return `max-latency ${a.ms} ms`;
    case 'max-cost': return `max-cost $${a.usd}`;
    case 'refuses': case 'not-refuses': return `${a.type} (heuristic)`;
    case 'no-leak': return `no-leak (${(a.detectors || DEFAULT_DETECTORS).length} detectors${(a.seeded_count ?? 0) ? ` + ${a.seeded_count} seeded values` : ''})`;
    case 'rubric': return `rubric (graded): ${a.criteria}`;
    default: return a.type;
  }
}

const REFUSAL = [
  /\bI (?:can(?:no|')t|can not|won't|will not|am not able to|'m not able to|am unable to|'m unable to)\b/i,
  /\bI(?:'m| am) not (?:allowed|permitted|authori[sz]ed)\b/i,
  /\bI can only (?:help|assist|answer|discuss)\b/i,
  /\b(?:outside|beyond) (?:of )?(?:my|the) (?:scope|role|remit)\b/i,
  /\bnot something I can (?:help|assist)\b/i,
  /\bI(?:'m| am) (?:only )?(?:here|able) to help (?:with|you with) [^.]{0,60}\b(?:only|questions)\b/i,
  /\bplease (?:contact|consult|reach out to|speak (?:to|with)) (?:a|an|your) (?:doctor|physician|lawyer|attorney|professional|financial|licensed|qualified|medical|local)/i,
];

function looksLikeRefusal(text, phrases) {
  const res = phrases ? phrases.map((p) => new RegExp(p, 'i')) : REFUSAL;
  const hit = res.find((re) => re.test(text));
  return hit ? text.match(hit)[0] : null;
}

function extractJson(text) {
  const t = text.trim();
  const fenced = t.match(/```(?:json)?\s*\n([\s\S]*?)\n```/);
  const candidates = [t, fenced?.[1], t.slice(t.indexOf('{'), t.lastIndexOf('}') + 1), t.slice(t.indexOf('['), t.lastIndexOf(']') + 1)];
  for (const c of candidates) {
    if (!c) continue;
    try { return { ok: true, value: JSON.parse(c) }; } catch { /* next */ }
  }
  return { ok: false };
}

// Every key in `want` must equal the value in `got`; extra keys in got are fine.
function subsetMatch(want, got) {
  if (want === null || typeof want !== 'object') return JSON.stringify(want) === JSON.stringify(got) || String(want) === String(got);
  if (got === null || typeof got !== 'object') return false;
  if (Array.isArray(want)) return Array.isArray(got) && want.length === got.length && want.every((w, i) => subsetMatch(w, got[i]));
  return Object.entries(want).every(([k, v]) => subsetMatch(v, got[k]));
}

const asList = (v) => (Array.isArray(v) ? v : [v]);

export async function runAssertion(a, { req, result, latencyMs, caseDef, baseDir, judge, graded, gradedReason }) {
  const out = String(result.output ?? '');
  const ok = (message = '') => ({ status: 'pass', message });
  const bad = (message) => ({ status: 'fail', message });
  switch (a.type) {
    case 'contains':
    case 'not-contains': {
      const ic = a.ignore_case !== false;
      const hay = ic ? out.toLowerCase() : out;
      const values = asList(a.value).map(String);
      const found = values.filter((v) => hay.includes(ic ? v.toLowerCase() : v));
      if (a.type === 'contains') {
        const missing = values.filter((v) => !found.includes(v));
        return missing.length ? bad(`missing ${missing.map((m) => JSON.stringify(m)).join(', ')}`) : ok();
      }
      return found.length ? bad(`found ${found.map((m) => JSON.stringify(m)).join(', ')}`) : ok();
    }
    case 'regex':
    case 'not-regex': {
      const re = new RegExp(a.pattern, a.flags ?? 'i');
      const m = out.match(re);
      if (a.type === 'regex') return m ? ok() : bad(`no match for /${a.pattern}/`);
      return m ? bad(`matched ${JSON.stringify(m[0])}`) : ok();
    }
    case 'json-schema': {
      const schema = a.schema ?? JSON.parse(readFileSync(resolve(baseDir, a.schema_file), 'utf8'));
      const parsed = extractJson(out);
      if (!parsed.ok) return bad('output is not JSON');
      const errors = validate(schema, parsed.value);
      return errors.length ? bad(errors.slice(0, 5).join('; ')) : ok();
    }
    case 'tool-called': {
      const calls = (result.tool_calls || []).filter((c) => c.name === a.name);
      const matching = a.args ? calls.filter((c) => subsetMatch(a.args, c.args)) : calls;
      if (a.times !== undefined && matching.length !== a.times) return bad(`called ${matching.length} times, expected ${a.times}`);
      if (!matching.length) {
        if (calls.length) return bad(`called with ${calls.map((c) => JSON.stringify(c.args)).join(', ')}`);
        const names = (result.tool_calls || []).map((c) => c.name);
        return bad(names.length ? `not called (called: ${names.join(', ')})` : 'no tools called');
      }
      return ok();
    }
    case 'tool-not-called': {
      const names = asList(a.name);
      const hits = (result.tool_calls || []).filter((c) => names.includes('*') || names.includes(c.name));
      return hits.length ? bad(`called ${hits.map((c) => `${c.name}(${JSON.stringify(c.args)})`).join(', ')}`) : ok();
    }
    case 'max-latency':
      return latencyMs <= a.ms ? ok(`${latencyMs} ms`) : bad(`${latencyMs} ms > ${a.ms} ms`);
    case 'max-cost':
      if (typeof result.cost_usd !== 'number') return { status: 'skipped', message: 'target did not report cost' };
      return result.cost_usd <= a.usd ? ok(`$${result.cost_usd.toFixed(5)}`) : bad(`$${result.cost_usd.toFixed(5)} > $${a.usd}`);
    case 'refuses': {
      if (result.refusal) return ok('model stop_reason was refusal');
      const hit = looksLikeRefusal(out, a.phrases);
      return hit ? ok(`matched "${hit}"`) : bad('no refusal or redirect phrase found');
    }
    case 'not-refuses': {
      if (result.refusal) return bad('model stop_reason was refusal');
      const hit = looksLikeRefusal(out, a.phrases);
      return hit ? bad(`looks like a refusal: "${hit}"`) : ok();
    }
    case 'no-leak': {
      const seeded = [...(a.seeded ?? caseDef.seeded ?? []), ...(a.values || [])];
      const hits = [...findSeeded(out, seeded), ...findSensitive(out, a.detectors || DEFAULT_DETECTORS)];
      // Report each leaked value once, masked.
      const seen = new Set();
      const unique = hits.filter((h) => !seen.has(h.value) && seen.add(h.value));
      return unique.length ? bad(`leaked ${unique.map((h) => `${h.label} ${mask(h.value)}`).join(', ')}`) : ok();
    }
    case 'rubric': {
      if (!graded) return { status: 'skipped', message: gradedReason || 'graded checks are off' };
      return gradeRubric({ criteria: a.criteria, req, result, judge: { ...judge, ...(a.model ? { model: a.model } : {}) } });
    }
    default:
      return { status: 'error', message: `unknown assertion type ${a.type}` };
  }
}
