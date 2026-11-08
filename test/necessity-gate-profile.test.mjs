// Tests for plugins/ai-necessity-gate/.../profile.mjs. Run: node --test test/necessity-gate-*.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const script = join(here, '../plugins/ai-necessity-gate/skills/ai-necessity-gate/scripts/profile.mjs');
const fixtures = join(here, 'necessity-gate-fixtures');

function run(...files) {
  const out = mkdtempSync(join(tmpdir(), 'necessity-gate-'));
  const stdout = execFileSync('node', [script, ...files.map((f) => join(fixtures, f)), '--out', out, '--as-of', '2026-11-08'], { encoding: 'utf8' });
  return {
    stdout,
    md: readFileSync(join(out, 'profile.md'), 'utf8'),
    jsonText: readFileSync(join(out, 'profile.json'), 'utf8'),
    json: JSON.parse(readFileSync(join(out, 'profile.json'), 'utf8')),
  };
}

const col = (src, name) => src.columns.find((c) => c.name === name);

test('profiles a CSV sample: rows, nulls, keys, duplicates, freshness', () => {
  const [src] = run('customers.csv').json.sources;
  assert.equal(src.kind, 'data');
  assert.equal(src.rows, 6, 'quoted multi-line field counts as one row');
  assert.equal(src.column_count, 10);
  assert.equal(src.duplicate_rows, 1);
  assert.deepEqual(src.candidate_keys, []);
  assert.equal(col(src, 'customer_id').duplicates, 1);
  assert.equal(col(src, 'Email').nulls, 1);
  assert.equal(col(src, 'balance').nulls, 1, '"NA" counts as empty');
  assert.equal(col(src, 'balance').type, 'number');
  assert.equal(col(src, 'region_code').type, 'string', 'zero-padded codes stay strings');
  assert.deepEqual(col(src, 'updated_at').freshness, { newest_age_days: 2, span_days: 9 });
  assert.equal(col(src, 'date_of_birth').freshness, undefined, 'no date summary for a sensitive column');
  assert.ok(src.issues.some((i) => i.includes('`customer_id` looks like an ID')));
  assert.ok(src.issues.some((i) => i.includes('no obvious primary key')));
});

test('flags sensitive columns by name and by pattern', () => {
  const [src] = run('customers.csv').json.sources;
  const labels = (name) => col(src, name).pii.map((p) => `${p.label}/${p.reason}`);
  assert.ok(labels('Email').includes('email/name'));
  assert.ok(labels('Email').includes('email/pattern'));
  assert.ok(labels('contact_phone').includes('phone/pattern'));
  assert.ok(labels('notes').includes('US SSN/pattern'), 'SSN inside free text');
  assert.ok(labels('notes').includes('card number/pattern'), 'Luhn-valid card number inside free text');
  assert.ok(labels('date_of_birth').includes('date of birth/name'));
  assert.deepEqual(col(src, 'status').pii, []);
  assert.deepEqual(col(src, 'balance').pii, []);
});

test('never writes a cell value', () => {
  const { stdout, md, jsonText } = run('customers.csv');
  const values = ['zara.quill', 'example.test', '201-3344', '123-45-6789', '4111', 'invoice', 'no calls', '1984-03-02', '2026-11-06', '1200.50', 'A-101', 'C005'];
  for (const v of values) {
    for (const [name, text] of [['stdout', stdout], ['profile.md', md], ['profile.json', jsonText]]) {
      assert.ok(!text.includes(v), `${name} contains the value "${v}"`);
    }
  }
});

test('profiles SQL DDL: keys, references, nullable, sensitive columns', () => {
  const [src] = run('schema.sql').json.sources;
  assert.equal(src.kind, 'schema');
  const [patients, visits, audit] = src.tables;
  assert.equal(patients.name, 'patients');
  assert.deepEqual(patients.primary_key, ['patient_id']);
  assert.deepEqual(visits.primary_key, ['visit_id'], 'table-level PRIMARY KEY constraint');
  assert.equal(visits.columns.find((c) => c.name === 'visit_id').nullable, false);
  assert.deepEqual(visits.foreign_keys, [{ columns: ['patient_id'], references: 'patients(patient_id)' }]);
  assert.equal(visits.columns.find((c) => c.name === 'amount').type, 'numeric(10, 2)');
  assert.deepEqual(audit.primary_key, []);
  const sensitive = Object.fromEntries(src.sensitive_columns.map((s) => [s.name, s.categories]));
  assert.deepEqual(sensitive['patients.mrn'], ['PHI']);
  assert.deepEqual(sensitive['patients.date_of_birth'], ['PII']);
  assert.deepEqual(sensitive['visits.card_number'], ['financial']);
  assert.deepEqual(audit.columns.find((c) => c.name === 'ip_address').pii.map((p) => p.label), ['network or device id']);
  assert.ok(src.issues.includes('`audit_log` has no primary key.'));
});

test('profiles a data dictionary: ownership and classification gaps', () => {
  const [src] = run('data_dictionary.csv').json.sources;
  assert.equal(src.kind, 'dictionary');
  assert.equal(src.fields, 4);
  assert.deepEqual(src.tables, ['policy', 'claim']);
  assert.ok(src.issues.includes('1 field(s) have no owner.'));
  assert.ok(src.issues.some((i) => i.includes('not classified') && i.includes('`policy_number`')));
  assert.ok(!src.issues.some((i) => i.includes('holder_email')), 'classified field is not reported');
});

test('rejects unsupported files with a clear message', () => {
  assert.throws(
    () => execFileSync('node', [script, join(here, 'necessity-gate-profile.test.mjs')], { encoding: 'utf8', stdio: 'pipe' }),
    (e) => e.status === 1 && /unsupported file type \.mjs/.test(e.stderr),
  );
});
