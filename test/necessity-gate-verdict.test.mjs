// Tests for plugins/ai-necessity-gate/.../gate.mjs: the verdict rules in
// references/rubric.md, and the three worked examples.
// Run: node --test test/necessity-gate-*.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const skill = join(here, '../plugins/ai-necessity-gate/skills/ai-necessity-gate');
const script = join(skill, 'scripts/gate.mjs');
const { evaluate, TESTS } = await import(script);

// Build a scored gate from per-test score arrays, in rubric criterion order.
function scored({ simplicity, clarity, data }, flags = {}) {
  const g = { alternative: { best: 'rules' }, risk: { flags: { decisions_about_people: false, regulated_data: false, unreviewed_external_output: false, personal_data: false, money_movement: false, ...flags } } };
  for (const [t, scores] of Object.entries({ simplicity, clarity, data })) {
    g[t] = Object.fromEntries(TESTS[t].map((c, i) => [c, { score: scores[i], evidence: 'test' }]));
  }
  return g;
}
const verdict = (s, f) => evaluate(scored(s, f)).result;

test('rule 1: Simplicity fails means Not AI, whatever else scores', () => {
  assert.equal(verdict({ simplicity: [1, 1, 1, 0], clarity: [2, 2, 2, 2], data: [2, 2, 2, 2] }).verdict, 'not_ai', 'total 3');
  assert.equal(verdict({ simplicity: [2, 2, 2, 0], clarity: [2, 2, 2, 2], data: [2, 2, 2, 2] }).verdict, 'not_ai', 'alternative scored 0');
  assert.equal(verdict({ simplicity: [0, 1, 2, 1], clarity: [2, 2, 2, 2], data: [2, 2, 2, 2] }).verdict, 'go', 'total 4 with an alternative passes');
});

test('rule 2: Clarity fails means Not yet', () => {
  const r = verdict({ simplicity: [2, 2, 2, 2], clarity: [0, 2, 2, 2], data: [2, 2, 2, 2] });
  assert.deepEqual([r.verdict, r.rule], ['not_yet', 2], 'hours-only value');
  assert.equal(verdict({ simplicity: [2, 2, 2, 2], clarity: [2, 2, 0, 2], data: [2, 2, 2, 2] }).verdict, 'not_yet', 'no owner');
  assert.equal(verdict({ simplicity: [2, 2, 2, 2], clarity: [1, 1, 1, 1], data: [2, 2, 2, 2] }).verdict, 'not_yet', 'total 4');
  assert.equal(verdict({ simplicity: [2, 2, 2, 2], clarity: [1, 2, 1, 1], data: [2, 2, 2, 2] }).verdict, 'go', 'total 5');
});

test('rules 3 to 5: Data decides between Go, Go after fixing data and Not yet', () => {
  const base = { simplicity: [2, 2, 2, 2], clarity: [2, 2, 2, 2] };
  assert.equal(verdict({ ...base, data: [2, 1, 2, 2] }).verdict, 'go', '7 with no zero');
  assert.equal(verdict({ ...base, data: [2, 0, 2, 2] }).verdict, 'go_after_fixing_data', 'a zero blocks Go');
  assert.equal(verdict({ ...base, data: [1, 1, 1, 1] }).verdict, 'go_after_fixing_data');
  const r = verdict({ ...base, data: [0, 2, 2, 2] });
  assert.deepEqual([r.verdict, r.rule], ['not_yet', 5], 'data not captured');
  assert.equal(verdict({ ...base, data: [2, 2, 0, 2] }).verdict, 'not_yet', 'nobody owns the data');
});

test('risk level and human review follow the flags', () => {
  const s = { simplicity: [2, 2, 2, 2], clarity: [2, 2, 2, 2], data: [2, 2, 2, 2] };
  assert.equal(verdict(s).risk_level, 'low');
  assert.equal(verdict(s, { money_movement: true }).risk_level, 'medium');
  assert.equal(verdict(s, { personal_data: true }).risk_level, 'medium');
  const high = verdict(s, { personal_data: true, regulated_data: true });
  assert.equal(high.risk_level, 'high');
  assert.match(high.human_review, /every output/);
});

test('rejects missing scores, out-of-range scores and missing evidence', () => {
  const g = scored({ simplicity: [2, 2, 2, 2], clarity: [2, 2, 2, 2], data: [2, 2, 2, 2] });
  g.clarity.owner.score = 3;
  g.data.quality.score = null;
  g.simplicity.rules.evidence = '';
  delete g.risk.flags.personal_data;
  const { errors } = evaluate(g);
  assert.ok(errors.includes('clarity.owner.score must be 0, 1 or 2'));
  assert.ok(errors.includes('data.quality.score must be 0, 1 or 2'));
  assert.ok(errors.some((e) => e.startsWith('simplicity.rules.evidence is missing')));
  assert.ok(errors.includes('risk.flags.personal_data must be true or false'));
});

for (const [example, expected] of [
  ['go-animal-health', 'Go'],
  ['not-ai-supply-chain', 'Not AI'],
  ['fix-data-equipment-finance', 'Go after fixing data'],
]) {
  test(`example ${example} gives ${expected}`, () => {
    const dir = mkdtempSync(join(tmpdir(), 'necessity-gate-'));
    copyFileSync(join(skill, 'references/examples', example, 'gate.json'), join(dir, 'gate.json'));
    const stdout = execFileSync('node', [script, join(dir, 'gate.json')], { encoding: 'utf8' });
    assert.match(stdout, new RegExp(`^Verdict: ${expected} \\(`));
    const md = readFileSync(join(dir, 'gate.md'), 'utf8');
    assert.ok(md.includes(`**Verdict: ${expected}.**`));
    for (const h of ['## Why', '## Scores', '## Biggest risks', '## First build', '## How to measure it', '## Who signs off']) assert.ok(md.includes(h), h);
    assert.equal((md.match(/^\d\. /gm) || []).length, 3, 'exactly three risks');
    assert.ok(!/\b(blocker|veto|hurdle)\b/i.test(md), 'security is never a blocker');
    // The committed one-pager is what the script renders today.
    assert.equal(md, readFileSync(join(skill, 'references/examples', example, 'gate.md'), 'utf8'));
  });
}

test('exits 2 and lists narrative gaps when only scores are filled in', () => {
  const dir = mkdtempSync(join(tmpdir(), 'necessity-gate-'));
  const g = scored({ simplicity: [2, 2, 2, 2], clarity: [2, 2, 2, 2], data: [1, 1, 1, 1] });
  writeFileSync(join(dir, 'gate.json'), JSON.stringify(g));
  const r = spawnSync('node', [script, join(dir, 'gate.json')], { encoding: 'utf8' });
  assert.equal(r.status, 2);
  assert.match(r.stdout, /^Verdict: Go after fixing data/);
  assert.match(r.stdout, /data_fixes/);
  assert.match(r.stdout, /top_risks/);
  assert.equal(JSON.parse(readFileSync(join(dir, 'gate.json'), 'utf8')).result.verdict, 'go_after_fixing_data', 'verdict saved to gate.json');
  assert.ok(!existsSync(join(dir, 'gate.md')));
});

test('the template is rejected until it is scored', () => {
  const dir = mkdtempSync(join(tmpdir(), 'necessity-gate-'));
  copyFileSync(join(skill, 'references/gate.template.json'), join(dir, 'gate.json'));
  const r = spawnSync('node', [script, join(dir, 'gate.json')], { encoding: 'utf8' });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /simplicity\.input\.score must be 0, 1 or 2/);
});
