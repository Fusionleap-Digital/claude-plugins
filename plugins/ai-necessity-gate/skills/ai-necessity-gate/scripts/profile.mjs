#!/usr/bin/env node
// Profile a data sample, SQL schema or data dictionary for the Data Test.
// Reports shape, nulls, keys, freshness and likely PII/PHI/financial columns.
// Never prints or writes a cell value: only counts, rates, ages and column names.
//
//   node profile.mjs <file>... [--out dir] [--as-of YYYY-MM-DD] [--stale-days 90] [--dictionary]
//
// .csv .tsv .txt  data sample (delimiter detected), or a data dictionary when the
//                 file name says dictionary/glossary/catalog or --dictionary is set
// .sql .ddl       CREATE TABLE statements

import { createReadStream, readFileSync, writeFileSync, mkdirSync, statSync } from 'node:fs';
import { basename, extname, join, resolve } from 'node:path';
import { createHash } from 'node:crypto';

const NULLS = new Set(['', 'null', 'na', 'n/a', 'none', 'nan', 'nil', '#n/a']);
const DISTINCT_CAP = 1_000_000;
const PATTERN_CAP = 200_000;

// Column-name hints. Matched against the name split into lowercase words, and
// against the joined name, so "PatientDOB", "patient_dob" and "dob" all hit.
const NAME_HINTS = [
  // [category, label, regex on the normalised name]
  ['PII', 'email', /(^|_)e_?mail(_|$)/],
  ['PII', 'phone', /(^|_)(phone|mobile|cell|tel|telephone|fax)(_|$)/],
  ['PII', 'government id', /(^|_)(ssn|social_security|sin|national_id|nin|passport|driver_?s?_licen[cs]e|dl_number)(_|$)/],
  ['PII', 'date of birth', /(^|_)(dob|date_of_birth|birth_?date|birthday)(_|$)/],
  ['PII', 'person name', /(^|_)(first_?name|last_?name|full_?name|surname|given_?name|middle_?name|maiden_?name|contact_?name|owner_?name|customer_?name)(_|$)/],
  ['PII', 'address', /(^|_)(address|addr|street|address_?line\d?|zip|zip_?code|postal|postcode|post_code)(_|$)/],
  ['PII', 'network or device id', /(^|_)(ip|ip_?address|device_?id|mac_?address|imei|cookie_?id)(_|$)/],
  ['PII', 'demographic', /(^|_)(gender|sex|ethnicity|race|religion|marital_?status|nationality)(_|$)/],
  ['PHI', 'medical record', /(^|_)(mrn|medical_?record|patient_?id|chart_?number)(_|$)/],
  ['PHI', 'clinical', /(^|_)(diagnosis|dx|icd\d*|cpt|procedure_?code|prescription|rx|medication|lab_?result|condition|allergy|treatment)(_|$)/],
  ['PHI', 'health plan id', /(^|_)(member_?id|subscriber_?id|health_?plan|insurance_?id|policy_?number)(_|$)/],
  ['financial', 'account number', /(^|_)(account_?(number|no|num)|acct_?(number|no|num)?|iban|routing|aba|swift|bic|sort_?code)(_|$)/],
  ['financial', 'card data', /(^|_)(card_?number|cc_?number|pan|cvv|cvc|card_?expiry)(_|$)/],
  ['financial', 'tax id', /(^|_)(tax_?id|tin|ein|vat_?number)(_|$)/],
  ['financial', 'credit or income', /(^|_)(credit_?score|fico|salary|income|net_?worth|wage)(_|$)/],
];

// Value patterns. Unanchored, so free-text notes that contain an SSN still count.
const VALUE_PATTERNS = [
  ['PII', 'email', /[^\s@<>()",;]+@[^\s@<>()",;]+\.[A-Za-z]{2,}/],
  ['PII', 'US SSN', /\b\d{3}-\d{2}-\d{4}\b/],
  ['PII', 'phone', /(?:\+?\d{1,2}[\s.-]?)?\(?\b\d{3}\)?[\s.-]\d{3}[\s.-]\d{4}\b/],
  ['PII', 'IPv4', /\b(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)\b/],
  ['financial', 'IBAN', /\b[A-Z]{2}\d{2}[A-Z0-9]{11,30}\b/],
  ['financial', 'card number', null], // Luhn check below
];
const CARD = /\b(?:\d[ -]?){12,18}\d\b/;

function luhn(digits) {
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let d = +digits[digits.length - 1 - i];
    if (i % 2) { d *= 2; if (d > 9) d -= 9; }
    sum += d;
  }
  return sum % 10 === 0;
}

function normName(name) {
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_|_$/g, '');
}

function nameHints(name) {
  const n = normName(name);
  const hits = [];
  for (const [category, label, re] of NAME_HINTS) if (re.test(n)) hits.push({ category, label, reason: 'name' });
  // "ip_address" and "email_address" are not street addresses.
  if (hits.length > 1) return hits.filter((h) => h.label !== 'address');
  return hits;
}

// ---------- types and dates ----------

const ISO = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/;
const US = /^(\d{1,2})\/(\d{1,2})\/(\d{4})(?: (\d{1,2}):(\d{2})(?::(\d{2}))?)?$/;

function parseDate(v) {
  let m = ISO.exec(v);
  if (m) {
    const t = Date.UTC(+m[1], +m[2] - 1, +m[3], +(m[4] || 0), +(m[5] || 0), +(m[6] || 0));
    return +m[2] >= 1 && +m[2] <= 12 && +m[3] >= 1 && +m[3] <= 31 ? t : null;
  }
  m = US.exec(v);
  if (m) {
    if (+m[1] < 1 || +m[1] > 12 || +m[2] < 1 || +m[2] > 31) return null;
    return Date.UTC(+m[3], +m[1] - 1, +m[2], +(m[4] || 0), +(m[5] || 0), +(m[6] || 0));
  }
  return null;
}

function kindOf(v) {
  if (/^[+-]?\d+$/.test(v)) return v.length > 1 && v[0] === '0' ? 'string' : 'integer'; // keep zero-padded codes as strings
  if (/^[+-]?(\d+\.\d*|\.\d+|\d+)(e[+-]?\d+)?$/i.test(v)) return 'number';
  if (/^(true|false|yes|no|y|n)$/i.test(v)) return 'boolean';
  if (parseDate(v) !== null) return 'date';
  return 'string';
}

// ---------- CSV ----------

async function* csvRows(path, delimiter) {
  let field = '', row = [], inQuotes = false, quoteSeen = false;
  const stream = createReadStream(path, { encoding: 'utf8', highWaterMark: 1 << 20 });
  let first = true;
  for await (let chunk of stream) {
    if (first) { chunk = chunk.replace(/^﻿/, ''); first = false; }
    for (let i = 0; i < chunk.length; i++) {
      const c = chunk[i];
      if (inQuotes) {
        if (c === '"') {
          if (chunk[i + 1] === '"') { field += '"'; i++; }
          else if (i + 1 === chunk.length) { quoteSeen = true; inQuotes = false; } // may be "" split across chunks; handled below
          else inQuotes = false;
        } else field += c;
        continue;
      }
      if (quoteSeen) { quoteSeen = false; if (c === '"') { field += '"'; inQuotes = true; continue; } }
      if (c === '"' && field === '') inQuotes = true;
      else if (c === delimiter) { row.push(field); field = ''; }
      else if (c === '\n') { row.push(field.replace(/\r$/, '')); yield row; row = []; field = ''; }
      else field += c;
    }
  }
  if (field !== '' || row.length) { row.push(field.replace(/\r$/, '')); yield row; }
}

function detectDelimiter(path) {
  if (extname(path).toLowerCase() === '.tsv') return '\t';
  const head = readFileSync(path, { encoding: 'utf8' }).slice(0, 65536).split(/\r?\n/)[0] || '';
  const outside = head.replace(/"[^"]*"/g, '');
  let best = ',', count = -1;
  for (const d of [',', '\t', ';', '|']) {
    const n = outside.split(d).length - 1;
    if (n > count) { best = d; count = n; }
  }
  return best;
}

function newColumn(name) {
  return {
    name, nonEmpty: 0, nulls: 0,
    kinds: { integer: 0, number: 0, boolean: 0, date: 0, string: 0 },
    distinct: new Set(), capped: false,
    minDate: null, maxDate: null,
    checked: 0, matches: new Map(),
  };
}

function observe(col, raw) {
  const v = raw.trim();
  if (NULLS.has(v.toLowerCase())) { col.nulls++; return; }
  col.nonEmpty++;
  const k = kindOf(v);
  col.kinds[k]++;
  if (k === 'date') {
    const t = parseDate(v);
    if (col.minDate === null || t < col.minDate) col.minDate = t;
    if (col.maxDate === null || t > col.maxDate) col.maxDate = t;
  }
  if (!col.capped) {
    col.distinct.add(v.length > 64 ? createHash('sha1').update(v).digest('base64') : v);
    if (col.distinct.size >= DISTINCT_CAP) col.capped = true;
  }
  if (col.checked < PATTERN_CAP && (k === 'string' || k === 'integer')) {
    col.checked++;
    for (const [category, label, re] of VALUE_PATTERNS) {
      let hit;
      if (re) hit = re.test(v);
      else { const m = CARD.exec(v); hit = !!m && luhn(m[0].replace(/\D/g, '')); }
      if (hit) col.matches.set(label, { category, label, count: (col.matches.get(label)?.count || 0) + 1 });
    }
  }
}

async function profileCsv(path, opts) {
  const delimiter = detectDelimiter(path);
  let header = null, cols = [], rows = 0, ragged = 0;
  const seenRows = new Set();
  let dupRows = 0, dupCapped = false;
  for await (const r of csvRows(path, delimiter)) {
    if (!header) {
      if (r.length === 1 && r[0].trim() === '') continue;
      header = r.map((h, i) => h.trim() || `column_${i + 1}`);
      cols = header.map(newColumn);
      continue;
    }
    if (r.length === 1 && r[0].trim() === '') continue; // blank line
    rows++;
    if (r.length !== header.length) ragged++;
    for (let i = 0; i < cols.length; i++) observe(cols[i], r[i] ?? '');
    if (!dupCapped) {
      const h = createHash('sha1').update(r.join('\u0001')).digest('base64');
      if (seenRows.has(h)) dupRows++; else seenRows.add(h);
      if (seenRows.size >= DISTINCT_CAP * 2) dupCapped = true;
    }
  }
  if (!header) throw new Error(`${path}: empty file`);

  const now = opts.asOf;
  const columns = cols.map((c) => {
    const total = c.nonEmpty + c.nulls;
    const dominant = Object.entries(c.kinds).sort((a, b) => b[1] - a[1])[0];
    let type = 'empty';
    if (c.nonEmpty) {
      if (dominant[1] / c.nonEmpty >= 0.95) type = dominant[0];
      else if (c.kinds.integer + c.kinds.number >= 0.95 * c.nonEmpty) type = 'number';
      else type = 'mixed';
    }
    const pii = nameHints(c.name);
    for (const m of c.matches.values()) {
      // Phone and IP patterns are noisy; count them only when they are common or the name agrees.
      const rate = m.count / Math.max(c.checked, 1);
      const noisy = m.label === 'phone' || m.label === 'IPv4';
      if (noisy && rate < 0.05 && !pii.some((p) => p.label.startsWith(m.label === 'phone' ? 'phone' : 'network'))) continue;
      pii.push({ category: m.category, label: m.label, reason: 'pattern', matches: m.count, match_rate: round(rate) });
    }
    const distinct = c.distinct.size;
    const out = {
      name: c.name,
      type,
      nulls: c.nulls,
      null_rate: round(total ? c.nulls / total : 0),
      distinct,
      distinct_capped: c.capped,
      candidate_key: rows > 1 && c.nulls === 0 && !c.capped && distinct === rows,
      duplicates: c.capped ? null : c.nonEmpty - distinct,
      pii,
    };
    out.id_like = /(^|_)(id|key|uuid|guid|number|no|num)$/.test(normName(c.name));
    // Freshness for date columns, as ages only. Skipped for sensitive columns (a date of birth is PII).
    if (type === 'date' && c.maxDate !== null && !pii.length) {
      out.freshness = {
        newest_age_days: Math.floor((now - c.maxDate) / 86_400_000),
        span_days: Math.floor((c.maxDate - c.minDate) / 86_400_000),
      };
    }
    c.distinct = null;
    return out;
  });

  const issues = [];
  if (!rows) issues.push('No data rows, only a header.');
  if (ragged) issues.push(`${ragged} row(s) have a different number of fields than the header.`);
  if (dupRows) issues.push(`${dupRows} exact duplicate row(s).`);
  const keys = columns.filter((c) => c.candidate_key);
  if (rows > 1 && !keys.length) issues.push('No single column is unique and complete, so there is no obvious primary key.');
  for (const c of columns) {
    if (c.type === 'empty') issues.push(`\`${c.name}\` is empty in every row.`);
    else if (c.null_rate >= 0.2) issues.push(`\`${c.name}\` is ${pct(c.null_rate)} empty.`);
    if (c.id_like && !c.candidate_key && c.duplicates) issues.push(`\`${c.name}\` looks like an ID but has ${c.duplicates} repeated value(s)${c.nulls ? ` and ${c.nulls} empty` : ''}.`);
    if (c.type === 'mixed') issues.push(`\`${c.name}\` mixes types (${Object.entries(cols.find((x) => x.name === c.name).kinds).filter(([, n]) => n).map(([k, n]) => `${k} ${n}`).join(', ')}).`);
    if (c.freshness && c.freshness.newest_age_days > opts.staleDays) issues.push(`\`${c.name}\`: newest value is ${c.freshness.newest_age_days} days old.`);
    if (c.freshness && c.freshness.newest_age_days < -1) issues.push(`\`${c.name}\` has dates in the future (up to ${-c.freshness.newest_age_days} days ahead).`);
  }

  return {
    file: basename(path), kind: 'data', format: delimiter === '\t' ? 'tsv' : 'csv', delimiter: delimiter === '\t' ? 'tab' : delimiter,
    rows, column_count: columns.length, duplicate_rows: dupCapped ? null : dupRows,
    candidate_keys: keys.map((c) => c.name),
    sensitive_columns: columns.filter((c) => c.pii.length).map((c) => ({ name: c.name, categories: [...new Set(c.pii.map((p) => p.category))] })),
    columns, issues,
  };
}

// ---------- data dictionary ----------

const DICT_COLS = {
  name: ['column', 'column_name', 'field', 'field_name', 'name', 'attribute', 'variable', 'element'],
  table: ['table', 'table_name', 'entity', 'dataset', 'source'],
  type: ['type', 'data_type', 'datatype', 'format'],
  description: ['description', 'desc', 'definition', 'meaning', 'notes', 'comment'],
  owner: ['owner', 'data_owner', 'steward', 'data_steward'],
  classification: ['classification', 'sensitivity', 'pii', 'sensitive', 'data_class'],
};
const DESC_HINTS = [
  ['PII', /\b(e-?mail|phone|social security|ssn|date of birth|birth ?date|home address|street address|passport|driver'?s licen[cs]e|full name|first name|last name)\b/i],
  ['PHI', /\b(diagnos[ie]s|medical record|patient|prescription|medication|clinical|treatment|lab result|health plan)\b/i],
  ['financial', /\b(account number|routing number|iban|card number|credit card|tax id|ein|salary|income|credit score)\b/i],
];

async function profileDictionary(path) {
  const delimiter = detectDelimiter(path);
  let header = null, idx = {};
  const fields = [];
  for await (const r of csvRows(path, delimiter)) {
    if (!header) {
      header = r.map((h) => normName(h));
      for (const [k, names] of Object.entries(DICT_COLS)) idx[k] = header.findIndex((h) => names.includes(h));
      if (idx.name < 0) throw new Error(`${path}: can't find the field-name column (looked for ${DICT_COLS.name.join(', ')})`);
      continue;
    }
    if (r.every((x) => !x.trim())) continue;
    const get = (k) => (idx[k] >= 0 ? (r[idx[k]] || '').trim() : '');
    const name = get('name');
    const pii = nameHints(name);
    const desc = get('description');
    for (const [category, re] of DESC_HINTS) if (re.test(desc) && !pii.some((p) => p.category === category)) pii.push({ category, label: 'description mentions it', reason: 'description' });
    fields.push({ table: get('table') || null, name, has_type: !!get('type'), has_description: !!desc, has_owner: !!get('owner'), classified: !!get('classification'), pii });
  }
  const tables = [...new Set(fields.map((f) => f.table).filter(Boolean))];
  const issues = [];
  const noDesc = fields.filter((f) => !f.has_description).length;
  if (idx.description < 0) issues.push('No description column.');
  else if (noDesc) issues.push(`${noDesc} of ${fields.length} fields have no description.`);
  if (idx.owner < 0) issues.push('No owner or steward column, so ownership has to be found another way.');
  else { const n = fields.filter((f) => !f.has_owner).length; if (n) issues.push(`${n} field(s) have no owner.`); }
  const unclassified = fields.filter((f) => f.pii.length && !f.classified);
  if (idx.classification < 0 && fields.some((f) => f.pii.length)) issues.push('Likely sensitive fields, but the dictionary has no classification column.');
  else if (unclassified.length) issues.push(`${unclassified.length} likely sensitive field(s) are not classified: ${unclassified.map((f) => `\`${f.name}\``).join(', ')}.`);
  return {
    file: basename(path), kind: 'dictionary', fields: fields.length, tables,
    sensitive_columns: fields.filter((f) => f.pii.length).map((f) => ({ name: f.table ? `${f.table}.${f.name}` : f.name, categories: [...new Set(f.pii.map((p) => p.category))] })),
    columns: fields, issues,
  };
}

// ---------- SQL DDL ----------

function splitTopLevel(s) {
  const parts = []; let depth = 0, cur = '', q = null;
  for (const c of s) {
    if (q) { cur += c; if (c === q) q = null; continue; }
    if (c === "'" || c === '"' || c === '`') { q = c; cur += c; continue; }
    if (c === '(') depth++;
    if (c === ')') depth--;
    if (c === ',' && depth === 0) { parts.push(cur.trim()); cur = ''; continue; }
    cur += c;
  }
  if (cur.trim()) parts.push(cur.trim());
  return parts;
}

const unquote = (s) => s.trim().replace(/^[`"[]|[`"\]]$/g, '');
const identList = (s) => s.split(',').map(unquote);

function profileDdl(path) {
  const sql = readFileSync(path, 'utf8').replace(/--[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
  const tables = [];
  const re = /create\s+(?:or\s+replace\s+)?(?:temp(?:orary)?\s+)?table\s+(?:if\s+not\s+exists\s+)?([`"[\]\w.]+)\s*\(/gi;
  let m;
  while ((m = re.exec(sql))) {
    let depth = 1, i = re.lastIndex;
    while (i < sql.length && depth) { if (sql[i] === '(') depth++; else if (sql[i] === ')') depth--; i++; }
    const body = sql.slice(re.lastIndex, i - 1);
    const name = m[1].split('.').map(unquote).join('.');
    const columns = []; let pk = []; const fks = [];
    for (const part of splitTopLevel(body)) {
      const pkm = /^(?:constraint\s+\S+\s+)?primary\s+key\s*\(([^)]*)\)/i.exec(part);
      if (pkm) { pk = identList(pkm[1]); continue; }
      const fkm = /^(?:constraint\s+\S+\s+)?foreign\s+key\s*\(([^)]*)\)\s*references\s+([`"[\]\w.]+)\s*\(([^)]*)\)/i.exec(part);
      if (fkm) { fks.push({ columns: identList(fkm[1]), references: `${unquote(fkm[2])}(${identList(fkm[3]).join(', ')})` }); continue; }
      if (/^(constraint|unique|key|index|check|exclude)\b/i.test(part)) continue;
      const cm = /^([`"[]?[^\s`"\]]+[`"\]]?)\s+([\w]+(?:\s*\([^)]*\))?(?:\s+varying)?(?:\s*\[\])?)(.*)$/is.exec(part);
      if (!cm) continue;
      const col = { name: unquote(cm[1]), type: cm[2].replace(/\s+/g, ' ').toLowerCase(), nullable: !/\bnot\s+null\b|\bprimary\s+key\b/i.test(cm[3]), pii: nameHints(unquote(cm[1])) };
      if (/\bprimary\s+key\b/i.test(cm[3])) pk = [col.name];
      const ref = /\breferences\s+([`"[\]\w.]+)\s*\(([^)]*)\)/i.exec(cm[3]);
      if (ref) fks.push({ columns: [col.name], references: `${unquote(ref[1])}(${identList(ref[2]).join(', ')})` });
      columns.push(col);
    }
    for (const c of columns) if (pk.includes(c.name)) c.nullable = false;
    tables.push({ name, columns, primary_key: pk, foreign_keys: fks });
  }
  if (!tables.length) throw new Error(`${path}: no CREATE TABLE statements found`);
  const issues = [];
  for (const t of tables) {
    if (!t.primary_key.length) issues.push(`\`${t.name}\` has no primary key.`);
    const ts = t.columns.filter((c) => /date|time/.test(c.type) && /(updated|modified|created|loaded|ingested|_at$|timestamp)/i.test(c.name));
    if (!ts.length) issues.push(`\`${t.name}\` has no created/updated timestamp column, so freshness can't be checked from the schema.`);
  }
  return {
    file: basename(path), kind: 'schema', tables: tables.map((t) => ({ ...t, column_count: t.columns.length })),
    sensitive_columns: tables.flatMap((t) => t.columns.filter((c) => c.pii.length).map((c) => ({ name: `${t.name}.${c.name}`, categories: [...new Set(c.pii.map((p) => p.category))] }))),
    issues,
  };
}

// ---------- output ----------

function round(x) { return Math.round(x * 10000) / 10000; }
function pct(x) { return `${(x * 100).toFixed(x < 0.01 && x > 0 ? 2 : 1)}%`; }
const piiText = (pii) => {
  const byLabel = new Map();
  for (const p of pii) {
    const key = `${p.category}: ${p.label}`;
    const why = p.reason === 'pattern' ? `${p.matches} value${p.matches === 1 ? '' : 's'} match` : p.reason === 'description' ? 'description' : 'name';
    byLabel.set(key, [...(byLabel.get(key) || []), why]);
  }
  return [...byLabel].map(([k, why]) => `${k} (${why.join('; ')})`).join('; ');
};

function toMarkdown(results, asOf) {
  const out = ['# Data profile', '', `As of ${new Date(asOf).toISOString().slice(0, 10)}. Counts, rates and column names only: no values were printed or stored.`, ''];
  for (const r of results) {
    out.push(`## ${r.file}`, '');
    if (r.kind === 'data') {
      out.push(`${r.rows.toLocaleString('en-US')} rows, ${r.column_count} columns (${r.format}). Candidate keys: ${r.candidate_keys.length ? r.candidate_keys.map((k) => `\`${k}\``).join(', ') : 'none'}. Duplicate rows: ${r.duplicate_rows ?? 'not counted (too many rows)'}.`, '');
      out.push('| Column | Type | Empty | Distinct | Key | Freshness | Sensitive |', '|---|---|---|---|---|---|---|');
      for (const c of r.columns) {
        const fresh = c.freshness ? `newest ${c.freshness.newest_age_days}d old, spans ${c.freshness.span_days}d` : '';
        const key = c.candidate_key ? 'unique' : c.id_like && c.duplicates ? `${c.duplicates} repeats` : '';
        out.push(`| \`${c.name}\` | ${c.type} | ${pct(c.null_rate)} | ${c.distinct.toLocaleString('en-US')}${c.distinct_capped ? '+' : ''} | ${key} | ${fresh} | ${piiText(c.pii)} |`);
      }
    } else if (r.kind === 'schema') {
      for (const t of r.tables) {
        out.push(`### ${t.name}`, '', `${t.column_count} columns. Primary key: ${t.primary_key.length ? t.primary_key.map((k) => `\`${k}\``).join(', ') : 'none'}.${t.foreign_keys.length ? ` References: ${t.foreign_keys.map((f) => `${f.columns.join(', ')} → ${f.references}`).join('; ')}.` : ''}`, '');
        out.push('| Column | Type | Nullable | Sensitive |', '|---|---|---|---|');
        for (const c of t.columns) out.push(`| \`${c.name}\` | ${c.type} | ${c.nullable ? 'yes' : 'no'} | ${piiText(c.pii)} |`);
        out.push('');
      }
    } else {
      out.push(`${r.fields} fields${r.tables.length ? ` across ${r.tables.length} table(s)` : ''}.`, '');
      const s = r.columns.filter((c) => c.pii.length);
      if (s.length) {
        out.push('| Field | Classified | Sensitive |', '|---|---|---|');
        for (const c of s) out.push(`| \`${c.table ? `${c.table}.` : ''}${c.name}\` | ${c.classified ? 'yes' : 'no'} | ${piiText(c.pii)} |`);
      }
    }
    out.push('', r.issues.length ? '**Issues**' : '**Issues:** none found.', '');
    for (const i of r.issues) out.push(`- ${i}`);
    out.push('');
  }
  return out.join('\n');
}

function parseArgs(argv) {
  const opts = { files: [], out: 'ai-necessity-gate', asOf: Date.now(), staleDays: 90, dictionary: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--out') opts.out = argv[++i];
    else if (a === '--as-of') { opts.asOf = Date.parse(argv[++i]); if (Number.isNaN(opts.asOf)) throw new Error('--as-of needs YYYY-MM-DD'); }
    else if (a === '--stale-days') opts.staleDays = +argv[++i];
    else if (a === '--dictionary') opts.dictionary = true;
    else if (a === '-h' || a === '--help') { opts.help = true; }
    else if (a.startsWith('--')) throw new Error(`unknown option ${a}`);
    else opts.files.push(a);
  }
  return opts;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help || !opts.files.length) {
    console.log('usage: profile.mjs <file.csv|file.tsv|schema.sql|dictionary.csv>... [--out dir] [--as-of YYYY-MM-DD] [--stale-days 90] [--dictionary]');
    process.exit(opts.help ? 0 : 2);
  }
  const results = [];
  for (const f of opts.files) {
    const path = resolve(f);
    statSync(path);
    const ext = extname(path).toLowerCase();
    if (['.sql', '.ddl'].includes(ext)) results.push(profileDdl(path));
    else if (['.csv', '.tsv', '.txt'].includes(ext)) {
      const dict = opts.dictionary || /dictionary|glossary|catalog|data_?dict/i.test(basename(path));
      results.push(dict ? await profileDictionary(path) : await profileCsv(path, opts));
    } else throw new Error(`${f}: unsupported file type ${ext || '(none)'}. Export it to CSV, or a schema to .sql.`);
  }
  mkdirSync(opts.out, { recursive: true });
  writeFileSync(join(opts.out, 'profile.json'), JSON.stringify({ as_of: new Date(opts.asOf).toISOString().slice(0, 10), sources: results }, null, 2) + '\n');
  writeFileSync(join(opts.out, 'profile.md'), toMarkdown(results, opts.asOf));
  for (const r of results) {
    const size = r.kind === 'data' ? `${r.rows} rows, ${r.column_count} columns` : r.kind === 'schema' ? `${r.tables.length} tables` : `${r.fields} fields`;
    console.log(`${r.file} (${r.kind}): ${size}; ${r.sensitive_columns.length} sensitive column(s); ${r.issues.length} issue(s)`);
  }
  console.log(`wrote ${join(opts.out, 'profile.md')} and profile.json`);
}

main().catch((e) => { console.error(`profile: ${e.message}`); process.exit(1); });
