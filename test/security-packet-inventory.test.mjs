// Tests for security-review-packet: runs the inventory on the fixture and
// checks the findings, then checks that check-packet.mjs passes the sample
// packet and fails broken ones. Run from the repo root:
//   node test/security-packet-inventory.test.mjs
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';

const SCRIPTS = 'plugins/security-review-packet/skills/security-review-packet/scripts';
const FIXTURE = 'test/security-packet-fixture';
const SAMPLE = 'plugins/security-review-packet/examples/claims-copilot';
const out = mkdtempSync(join(tmpdir(), 'srp-'));

let passed = 0;
const test = (name, fn) => {
  try { fn(); passed++; console.log(`ok    ${name}`); } catch (err) { console.log(`FAIL  ${name}\n      ${err.message.split('\n')[0]}`); process.exitCode = 1; }
};

execFileSync('node', [`${SCRIPTS}/inventory.mjs`, FIXTURE, '--out', out, '--no-audit'], { stdio: 'ignore' });
const inv = JSON.parse(readFileSync(join(out, 'inventory.json'), 'utf8'));
const raw = readFileSync(join(out, 'inventory.json'), 'utf8') + readFileSync(join(out, 'inventory.md'), 'utf8');
const flag = (re) => inv.flags.find((f) => re.test(f.title));

test('finds Anthropic, OpenAI and Bedrock', () => {
  for (const id of ['anthropic', 'openai', 'bedrock']) assert.ok(inv.providers.some((p) => p.id === id && p.confidence === 'code'), id);
});
test('finds model IDs, including the Bedrock cross-region profile', () => {
  const ids = inv.models.map((m) => m.id);
  for (const id of ['claude-sonnet-4-5', 'text-embedding-3-small', 'us.anthropic.claude-haiku-4-5-20251001-v1:0']) assert.ok(ids.includes(id), id);
});
test('finds pgvector, Postgres, Redis and S3', () => {
  for (const id of ['pgvector', 'postgres', 'redis', 's3']) assert.ok(inv.datastores.some((d) => d.id === id), id);
});
test('finds Langfuse as a vendor that receives prompts, and no false Arize match', () => {
  assert.ok(inv.vendors.some((v) => v.id === 'langfuse' && v.receivesPrompts));
  assert.ok(!inv.vendors.some((v) => v.id === 'arize'));
});
test('never writes the hard-coded token value', () => {
  assert.ok(!raw.includes('wk_7f3a9c2e1b8d4f60a2c5'));
  assert.equal(flag(/hardcoded-credential/)?.severity, 'critical');
});
test('env vars: names only, secret-like ones marked', () => {
  const v = inv.env.vars.find((x) => x.name === 'ANTHROPIC_API_KEY');
  assert.ok(v?.secretLike);
  assert.ok(!inv.env.vars.find((x) => x.name === 'AUTH_OKTA_ISSUER')?.secretLike);
});
test('routes: chat has auth, ingest has none, worker /documents uses Depends()', () => {
  const r = (p) => inv.routes.items.find((x) => x.path === p);
  assert.equal(r('/api/chat').auth.status, 'found');
  assert.equal(r('/api/ingest').auth.status, 'none-found');
  assert.equal(r('/documents').auth.status, 'found');
  assert.equal(r('/summarize').auth.status, 'none-found');
  assert.equal(r('/healthz').auth.status, 'none-found');
  assert.equal(flag(/\/api\/ingest/)?.severity, 'high');
  assert.equal(inv.routes.serverActions[0]?.name, 'submitFeedback');
});
test('agent tools: six tools, capabilities and approval steps', () => {
  const t = (n) => inv.agents.tools.find((x) => x.name === n);
  assert.equal(inv.agents.tools.length, 6);
  assert.ok(t('run_report_query').capabilities.arbitrarySql);
  assert.ok(t('fetch_url').capabilities.network);
  assert.ok(t('email_claimant').capabilities.sendMessage);
  assert.equal(t('update_claim_status').humanApproval?.strength, 'framework-approval');
  assert.equal(t('email_claimant').humanApproval?.strength, 'keyword-only');
  assert.equal(flag(/run_report_query/)?.severity, 'high');
  assert.ok(!flag(/update_claim_status/), 'approved tool should not be flagged');
});
test('MCP: two servers, unpinned npx flagged, env names only', () => {
  assert.deepEqual(inv.mcp.configs.map((m) => m.name).sort(), ['claims-db', 'github']);
  assert.deepEqual(inv.mcp.configs.find((m) => m.name === 'claims-db').envNames, ['PGPASSWORD']);
  assert.ok(flag(/claims-db.*unpinned/));
});
test('Terraform: region, encryption and exposure', () => {
  assert.ok(inv.iac.regions.some((r) => r.startsWith('us-east-1')));
  const res = (n) => inv.iac.resources.find((r) => `${r.type}.${r.name}` === n);
  assert.equal(res('aws_s3_bucket.docs').encryption.status, 'declared');
  assert.equal(res('aws_s3_bucket.exports').encryption.status, 'not-declared');
  assert.equal(res('aws_db_instance.main').encryption.status, 'declared');
  assert.ok(res('aws_lambda_function_url.worker').exposure.includes('authorization = NONE'));
  assert.ok(flag(/IAM policy grants access to all resources/));
});
test('controls: rate limit, approval, tenant filter, untrusted marking found', () => {
  for (const k of ['rateLimit', 'humanApproval', 'tenantIsolation', 'untrustedContentMarking', 'tokenAndStepLimits']) assert.ok(inv.controls[k].length, k);
});
test('data handling: prompts in logs (chat route and worker)', () => {
  const files = inv.dataHandling.promptLogging.map((r) => r.file);
  assert.ok(files.includes('app/api/chat/route.ts') && files.includes('worker/app.py'));
});
test('dependencies: Node and Python manifests read', () => {
  assert.ok(inv.dependencies.node.direct.some((d) => d.name === 'next' && d.license === 'MIT'));
  assert.ok(inv.dependencies.python.direct.some((d) => d.name === 'fastapi'));
});

// check-packet.mjs
const check = (packet, inventory = `${SAMPLE}/inventory.json`) => spawnSync('node', [`${SCRIPTS}/check-packet.mjs`, packet, '--inventory', inventory, '--root', FIXTURE], { encoding: 'utf8' });
const sample = readFileSync(`${SAMPLE}/packet.md`, 'utf8');
const variant = (name, text) => {
  const p = join(out, name);
  writeFileSync(p, text);
  return p;
};

test('sample packet passes the check', () => {
  const p = variant('ok.md', sample);
  const r = check(p);
  assert.equal(r.status, 0, r.stderr);
});
test('check fails an untagged statement', () => {
  const r = check(variant('untagged.md', sample.replace('- Identity provider: Okta via Auth.js; JWT sessions, 8 hour lifetime [Found: auth.ts:5-13]', '- Identity provider: Okta via Auth.js')));
  assert.equal(r.status, 1);
  assert.match(r.stderr, /no \[Found: file:line\]/);
});
test('check fails a citation past the end of the file', () => {
  const r = check(variant('badline.md', sample.replace('[Found: auth.ts:5-13]', '[Found: auth.ts:500]')));
  assert.equal(r.status, 1);
  assert.match(r.stderr, /auth\.ts has \d+ lines/);
});
test('check fails a missing high flag', () => {
  const r = check(variant('noflag.md', sample.replaceAll('F-003', 'F-0O3')));
  assert.equal(r.status, 1);
  assert.match(r.stderr, /Flag F-003/);
});
test('check fails a secret value in the packet', () => {
  const r = check(variant('secret.md', sample.replace('## 10. Open questions', '## 10. Open questions\n\n- Key is AKIAIOSFODNN7ABCDEFG [Ask team]')));
  assert.equal(r.status, 1);
  assert.match(r.stderr, /looks like a secret/);
});
test('check warns on compliance claims and "blocker"', () => {
  const r = check(variant('claims.md', sample.replace('## 10. Open questions', '## 10. Open questions\n\n- The system is compliant with SOC 2 and security is a blocker [Assumed]')));
  assert.match(r.stderr, /compliance claim/);
  assert.match(r.stderr, /blocker/);
});

console.log(`\n${passed} passed${process.exitCode ? ', some failed' : ''}`);
