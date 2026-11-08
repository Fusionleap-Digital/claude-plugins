// Dependencies, licenses and known vulnerabilities (npm audit / pip-audit).
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { isTestPath } from './files.mjs';

const COPYLEFT = /\b(A?GPL|LGPL|SSPL|EUPL|MPL|OSL|CDDL|EPL|CC-BY-SA|BUSL|Commons Clause|Elastic License)/i;

function has(cmd) {
  try { execFileSync('which', [cmd], { stdio: 'ignore' }); return true; } catch { return false; }
}

function parseRequirement(line) {
  const s = line.replace(/#.*/, '').trim();
  if (!s || s.startsWith('-')) return null;
  const m = s.match(/^([A-Za-z0-9][A-Za-z0-9._-]*)(\[[^\]]*\])?\s*(.*)$/);
  if (!m) return null;
  return { name: m[1].toLowerCase().replace(/_/g, '-'), spec: m[3].split(';')[0].trim() };
}

function pyprojectDeps(text) {
  const out = [];
  const arr = text.match(/^\s*dependencies\s*=\s*\[([\s\S]*?)\]/m);
  if (arr) for (const m of arr[1].matchAll(/["']([^"']+)["']/g)) { const r = parseRequirement(m[1]); if (r) out.push(r); }
  const poetry = text.match(/^\[tool\.poetry\.dependencies\]\s*\n([\s\S]*?)(?=^\[|$(?![\s\S]))/m);
  if (poetry) for (const line of poetry[1].split('\n')) {
    const m = line.match(/^\s*([A-Za-z0-9][A-Za-z0-9._-]*)\s*=\s*(.+)$/);
    if (m && m[1] !== 'python') out.push({ name: m[1].toLowerCase().replace(/_/g, '-'), spec: m[2].replace(/["'{}]/g, '').trim() });
  }
  return out;
}

function pythonLicenses(root) {
  const licenses = new Map();
  for (const venv of ['.venv', 'venv', 'env']) {
    const lib = join(root, venv, 'lib');
    if (!existsSync(lib)) continue;
    for (const py of readdirSync(lib)) {
      const sp = join(lib, py, 'site-packages');
      if (!existsSync(sp)) continue;
      for (const d of readdirSync(sp)) {
        if (!d.endsWith('.dist-info')) continue;
        let meta;
        try { meta = readFileSync(join(sp, d, 'METADATA'), 'utf8'); } catch { continue; }
        const name = (meta.match(/^Name:\s*(.+)$/m)?.[1] || '').trim().toLowerCase().replace(/_/g, '-');
        const version = (meta.match(/^Version:\s*(.+)$/m)?.[1] || '').trim();
        const lic = (meta.match(/^License-Expression:\s*(.+)$/m)?.[1] || meta.match(/^Classifier: License :: (?:OSI Approved :: )?(.+)$/m)?.[1] || meta.match(/^License:\s*(.{1,80})$/m)?.[1] || '').trim();
        if (name) licenses.set(name, { version, license: lic || null });
      }
    }
  }
  return licenses;
}

function npmAudit(dir) {
  try {
    const out = execFileSync('npm', ['audit', '--json', '--package-lock-only'], { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 120_000, maxBuffer: 32 * 1024 * 1024 });
    return JSON.parse(out);
  } catch (err) {
    // npm audit exits 1 when it finds vulnerabilities; the JSON is still on stdout.
    if (err.stdout) { try { return JSON.parse(err.stdout); } catch { /* fall through */ } }
    return { error: String(err.code || err.message).slice(0, 200) };
  }
}

function summarizeNpmAudit(raw) {
  if (raw.error) return { ran: false, reason: raw.error };
  const vulns = Object.values(raw.vulnerabilities || {}).map((v) => ({
    package: v.name,
    severity: v.severity,
    range: v.range,
    direct: v.isDirect,
    advisories: (v.via || []).filter((x) => typeof x === 'object').map((x) => ({ id: x.url?.split('/').pop() || null, title: x.title, severity: x.severity, url: x.url, cwe: x.cwe })),
    via: (v.via || []).filter((x) => typeof x === 'string'),
    fixAvailable: typeof v.fixAvailable === 'object' ? `${v.fixAvailable.name}@${v.fixAvailable.version}${v.fixAvailable.isSemVerMajor ? ' (major)' : ''}` : !!v.fixAvailable,
  }));
  return { ran: true, counts: raw.metadata?.vulnerabilities || null, vulnerabilities: vulns };
}

function pipAudit(reqPath, reqs) {
  if (!has('pip-audit')) return { ran: false, reason: 'pip-audit not installed (pipx install pip-audit)' };
  const unpinned = reqs.filter((r) => !/^==/.test(r.spec));
  if (unpinned.length) return { ran: false, reason: `not every requirement is pinned with == (${unpinned.slice(0, 5).map((r) => r.name).join(', ')}); pip-audit would have to install packages to resolve them. Run it by hand in a throwaway venv.` };
  try {
    const out = execFileSync('pip-audit', ['-r', reqPath, '--no-deps', '--disable-pip', '--format', 'json', '--progress-spinner', 'off'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 180_000 });
    return summarizePip(JSON.parse(out));
  } catch (err) {
    if (err.stdout) { try { return summarizePip(JSON.parse(err.stdout)); } catch { /* fall through */ } }
    return { ran: false, reason: String(err.stderr || err.message).split('\n')[0].slice(0, 200) };
  }
}

function summarizePip(raw) {
  const deps = raw.dependencies || raw;
  const vulns = [];
  const seen = new Set();
  for (const d of deps) for (const v of d.vulns || []) {
    const key = `${d.name}@${d.version}:${v.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    vulns.push({ package: d.name, version: d.version, id: v.id, aliases: v.aliases, fixVersions: v.fix_versions });
  }
  return { ran: true, vulnerabilities: vulns };
}

export function scanDependencies(root, repo, { audit = true } = {}) {
  const node = { manifests: [], direct: [], lockfiles: [], licenseSummary: {}, copyleft: [], unknownLicense: [] };
  const python = { manifests: [], direct: [], licenseSummary: {}, copyleft: [], unknownLicense: [], licensesFrom: null };
  const auditOut = { npm: [], pip: [] };
  const names = new Set();

  for (const f of repo.files) {
    const base = f.path.split('/').pop();
    if (base === 'package.json' && !f.path.includes('node_modules/')) {
      let pkg;
      try { pkg = JSON.parse(f.text); } catch { continue; }
      const dir = dirname(f.path);
      const lockPath = join(root, dir, 'package-lock.json');
      let lock = null;
      if (existsSync(lockPath)) { try { lock = JSON.parse(readFileSync(lockPath, 'utf8')); } catch { /* ignore */ } }
      const lockfile = lock ? 'package-lock.json' : ['pnpm-lock.yaml', 'yarn.lock', 'bun.lockb'].find((l) => existsSync(join(root, dir, l))) || null;
      node.manifests.push({ path: f.path, name: pkg.name || null, lockfile: lockfile ? join(dir, lockfile).replace(/^\.\//, '') : null, test: isTestPath(f.path) || undefined });
      for (const [field, dev] of [['dependencies', false], ['devDependencies', true], ['optionalDependencies', false], ['peerDependencies', false]]) {
        for (const [name, range] of Object.entries(pkg[field] || {})) {
          names.add(name);
          const locked = lock?.packages?.[`node_modules/${name}`];
          let license = locked?.license || null;
          let licenseFrom = license ? 'package-lock.json' : null;
          const installed = join(root, dir, 'node_modules', name, 'package.json');
          if (!license && existsSync(installed)) {
            try { const p = JSON.parse(readFileSync(installed, 'utf8')); license = typeof p.license === 'string' ? p.license : p.license?.type || null; licenseFrom = license ? 'node_modules' : null; } catch { /* ignore */ }
          }
          node.direct.push({ name, range, version: locked?.version || null, dev, license, licenseFrom, manifest: f.path });
        }
      }
      if (lock?.packages) {
        for (const [key, p] of Object.entries(lock.packages)) {
          if (!key) continue;
          const lic = p.license || 'UNKNOWN';
          node.licenseSummary[lic] = (node.licenseSummary[lic] || 0) + 1;
          const name = key.replace(/^.*node_modules\//, '');
          if (COPYLEFT.test(lic) && !node.copyleft.some((c) => c.name === name)) node.copyleft.push({ name, version: p.version, license: lic, dev: !!p.dev });
        }
      }
      if (audit && lock) {
        auditOut.npm.push({ manifest: f.path, sentTo: 'registry.npmjs.org (package names and versions only)', ...summarizeNpmAudit(npmAudit(join(root, dir))) });
      } else if (audit && !lock) {
        auditOut.npm.push({ manifest: f.path, ran: false, reason: lockfile ? `${lockfile} found; run \`${lockfile.startsWith('pnpm') ? 'pnpm audit --json' : lockfile.startsWith('yarn') ? 'yarn npm audit --json' : 'bun pm audit'}\` by hand` : 'no lockfile, so npm audit cannot run' });
      }
    }
    if (/(^|\/)requirements[^/]*\.txt$/.test(f.path) || base === 'pyproject.toml' || base === 'Pipfile') {
      const reqs = base === 'pyproject.toml' ? pyprojectDeps(f.text)
        : base === 'Pipfile' ? (f.text.match(/^\[packages\]\s*\n([\s\S]*?)(?=^\[|$(?![\s\S]))/m)?.[1] || '').split('\n').map((l) => l.match(/^\s*([A-Za-z0-9][A-Za-z0-9._-]*)\s*=\s*(.+)$/)).filter(Boolean).map((m) => ({ name: m[1].toLowerCase(), spec: m[2].replace(/["']/g, '') }))
        : f.lines.map(parseRequirement).filter(Boolean);
      python.manifests.push({ path: f.path, count: reqs.length });
      for (const r of reqs) { names.add(r.name); python.direct.push({ ...r, manifest: f.path }); }
      if (audit && /requirements[^/]*\.txt$/.test(f.path)) auditOut.pip.push({ manifest: f.path, sentTo: 'PyPI / OSV advisory databases (package names and versions only)', ...pipAudit(join(root, f.path), reqs) });
    }
  }

  if (python.direct.length) {
    const lic = pythonLicenses(root);
    python.licensesFrom = lic.size ? 'local virtualenv' : null;
    for (const d of python.direct) {
      const l = lic.get(d.name);
      d.license = l?.license || null;
      if (l?.version) d.installed = l.version;
      const key = d.license || 'UNKNOWN';
      python.licenseSummary[key] = (python.licenseSummary[key] || 0) + 1;
      if (d.license && COPYLEFT.test(d.license)) python.copyleft.push({ name: d.name, license: d.license });
      if (!d.license) python.unknownLicense.push(d.name);
    }
  }
  for (const d of node.direct) {
    if (d.license && COPYLEFT.test(d.license) && !node.copyleft.some((c) => c.name === d.name)) node.copyleft.push({ name: d.name, license: d.license, dev: d.dev });
    if (!d.license) node.unknownLicense.push(d.name);
  }
  return { node, python, audit: auditOut, names };
}
