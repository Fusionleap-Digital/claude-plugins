// API routes and whether an auth check is visible on each one.
// Next.js (app and pages router, server actions, middleware), Express-style
// routers (Express, Fastify, Hono, Koa), FastAPI and Flask.
import { ref, isComment } from './files.mjs';

const AUTH = /\b(getServerSession|getSession\(|auth\.api\.getSession|auth\(\)|await auth\b|currentUser\(|getAuth\(|clerkClient|withAuth|withApiAuth|requireAuth|requireUser|requireSession|requireAdmin|ensureAuth\w*|isAuthenticated|authenticate\w*\(|authorize\w*\(|verifyToken|verifyIdToken|verifyJwt|jwtVerify|jwt\.verify|getToken\(|validateSession|validateRequest|supabase\.auth\.getUser|auth\.getUser|fetchAuthSession|getCurrentUser|passport\.authenticate|login_required|jwt_required|permission_required|Security\(|HTTPBearer|OAuth2PasswordBearer|APIKeyHeader|get_current_user|current_user|verify_api_key|verify_token|require_api_key|check_api_key|api_key_auth|CognitoJwtVerifier|getUserFromRequest|unstable_getServerSession|checkAuth|protect\(\))/;
const HEADER_CHECK = /(headers?\(\)\.get\(\s*['"](authorization|x-api-key)|headers\[['"](authorization|x-api-key)|get\(\s*['"](authorization|x-api-key)['"]|request\.headers\.get\(\s*['"](authorization|x-api-key)|Header\(\s*\.\.\.|x-api-key|Authorization)/i;
const SIGNATURE = /(constructEvent|verifySignature|verify_signature|svix|webhooks\.verify|createHmac|hmac\.compare|timingSafeEqual|compare_digest)/;

function nextAppPath(p) {
  const m = p.match(/(?:^|\/)(?:src\/)?app\/(.*)\/route\.[cm]?[jt]sx?$/) || p.match(/(?:^|\/)(?:src\/)?app\/route\.[cm]?[jt]sx?$/);
  if (!m) return null;
  const segs = (m[1] || '').split('/').filter((s) => s && !/^\(.*\)$/.test(s) && !s.startsWith('@'));
  return `/${segs.join('/')}`;
}
function nextPagesPath(p) {
  const m = p.match(/(?:^|\/)(?:src\/)?pages\/(api\/.*)\.[cm]?[jt]sx?$/);
  if (!m) return null;
  return `/${m[1].replace(/\/index$/, '')}`;
}

// Project helpers that wrap an auth check (requireSiteAccess -> resolveSession
// -> auth.api.getSession). Found by following calls a few hops from AUTH.
let HELPERS = null;
let HELPER_DEFS = new Map();
function learnHelpers(files) {
  const defs = [];
  for (const f of files) {
    if (!/\.([cm]?[jt]sx?|py)$/.test(f.path) || f.test) continue;
    f.lines.forEach((l, i) => {
      const m = l.match(/^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s+(\w+)|^\s*(?:export\s+)?const\s+(\w+)\s*=\s*(?:async\s*)?\(|^(?:async\s+)?def\s+(\w+)/);
      if (!m) return;
      const name = m[1] || m[2] || m[3];
      if (/^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS|middleware|handler|default)$/.test(name) || name.length < 4) return;
      let end = i + 1;
      while (end < f.lines.length && end < i + 40 && !/^(export\s|async\s+def\s|def\s|function\s)/.test(f.lines[end])) end++;
      defs.push({ name, body: f.lines.slice(i + 1, end).join('\n'), file: f.path, line: i + 1 });
    });
  }
  const known = new Map();
  for (let round = 0; round < 4; round++) {
    const re = known.size ? new RegExp(`\\b(${[...known.keys()].join('|')})\\(`) : null;
    let added = false;
    for (const d of defs) {
      if (known.has(d.name)) continue;
      if (AUTH.test(d.body) || (re && re.test(d.body))) { known.set(d.name, d); added = true; }
    }
    if (!added) break;
  }
  HELPER_DEFS = known;
  HELPERS = known.size ? new RegExp(`\\b(${[...known.keys()].join('|')})\\(`) : null;
}

function authIn(text) {
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (isComment(lines[i])) continue;
    if (AUTH.test(lines[i])) return { status: 'found', kind: 'session-or-token-check', line: i };
    const h = HELPERS && lines[i].match(HELPERS);
    if (h && !/^\s*(export\s+)?(async\s+)?(function|def)\s/.test(lines[i])) {
      const d = HELPER_DEFS.get(h[1]);
      return { status: 'found', kind: `project auth helper ${h[1]}() at ${d.file}:${d.line}`, line: i };
    }
    if (SIGNATURE.test(lines[i])) return { status: 'found', kind: 'signature-check', line: i };
  }
  for (let i = 0; i < lines.length; i++) if (!isComment(lines[i]) && HEADER_CHECK.test(lines[i])) return { status: 'found', kind: 'header-check (read it: may be weak)', line: i };
  return null;
}

function matcherToRegex(m) {
  try {
    const src = m.replace(/:(\w+)\*/g, '.*').replace(/:(\w+)\+/g, '.+').replace(/:(\w+)\?/g, '[^/]*').replace(/:(\w+)(\((?:[^)]+)\))?/g, (a, n, g) => g || '[^/]+');
    return new RegExp(`^${src}$`);
  } catch { return null; }
}

function parseMiddleware(files) {
  const mw = files.find((f) => /^(src\/)?(middleware|proxy)\.[cm]?[jt]s$/.test(f.path));
  if (!mw) return null;
  const block = mw.text.match(/matcher\s*:\s*(\[[\s\S]*?\]|['"`][^'"`]+['"`])/);
  const matchers = block ? [...block[1].matchAll(/['"`]([^'"`]+)['"`]/g)].map((m) => m[1]) : [];
  const a = authIn(mw.text);
  const cookieIdx = mw.lines.findIndex((l) => /getSessionCookie\(|cookies\.(get|has)\(\s*['"`][^'"`]*(session|auth|token)/i.test(l));
  const authLike = a || cookieIdx >= 0 || /\bauth\b|export\s*\{\s*auth\s+as\s+(default|middleware)|clerkMiddleware|withAuth|NextAuth\(/.test(mw.text);
  // A cookie being present is not a validated session (better-auth's
  // getSessionCookie, a bare cookies.get('session')).
  const cookieOnly = cookieIdx >= 0 && !a;
  return { file: mw.path, matchers, coversAll: matchers.length === 0, hasAuth: !!authLike, cookieOnly,
    authRef: a ? ref(mw, a.line) : cookieIdx >= 0 ? ref(mw, cookieIdx) : null, regexes: matchers.map(matcherToRegex).filter(Boolean) };
}

const covered = (mw, path) => mw && mw.hasAuth && (mw.coversAll || mw.regexes.some((re) => re.test(path)));

export function scanRoutes(files) {
  learnHelpers(files);
  const items = [];
  const frameworks = new Set();
  const middleware = parseMiddleware(files);
  const serverActions = [];

  for (const f of files) {
    if (!/\.[cm]?[jt]sx?$|\.py$/.test(f.path)) continue;
    const appPath = nextAppPath(f.path);
    const pagesPath = nextPagesPath(f.path);
    if (appPath || pagesPath) {
      frameworks.add(appPath ? 'nextjs-app-router' : 'nextjs-pages-router');
      const path = appPath || pagesPath;
      const methods = [];
      f.lines.forEach((line, i) => {
        const m = line.match(/export\s+(?:async\s+)?(?:function|const)\s+(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\b/);
        if (m) methods.push([m[1], i]);
        const re = line.match(/export\s*\{([^}]*)\}/);
        if (re) for (const mm of re[1].matchAll(/as\s+(GET|POST|PUT|PATCH|DELETE)\b/g)) methods.push([mm[1], i]);
      });
      if (pagesPath && !methods.length) {
        const i = f.lines.findIndex((l) => /export\s+default/.test(l));
        const ms = [...new Set([...f.text.matchAll(/method\s*===?\s*['"](GET|POST|PUT|PATCH|DELETE)['"]/g)].map((m) => m[1]))];
        methods.push([ms.length ? ms.join('|') : 'ANY', Math.max(0, i)]);
      }
      const a = authIn(f.text);
      for (const [method, i] of methods) {
        const auth = a ? { status: 'found', kind: a.kind, ref: ref(f, a.line) }
          : covered(middleware, path) ? { status: 'middleware', kind: middleware.cookieOnly ? 'middleware checks that a session cookie exists, not that it is valid' : 'Next.js middleware matcher covers this path', ref: middleware.authRef || { file: middleware.file, line: 1 } }
          : { status: 'none-found' };
        items.push({ framework: frameworks.has('nextjs-app-router') && appPath ? 'nextjs' : 'nextjs-pages', method, path, file: f.path, line: i + 1, auth, test: f.test || undefined });
      }
      continue;
    }
    if (/^\s*['"]use server['"]/m.test(f.text)) {
      f.lines.forEach((line, i) => {
        const m = line.match(/export\s+(?:async\s+)?function\s+(\w+)|export\s+const\s+(\w+)\s*=\s*async/);
        if (!m) return;
        frameworks.add('nextjs-server-actions');
        const a = authIn(f.lines.slice(i, i + 25).join('\n'));
        serverActions.push({ name: m[1] || m[2], file: f.path, line: i + 1, auth: a ? { status: 'found', kind: a.kind, ref: ref(f, i + a.line) } : { status: 'none-found' } });
      });
    }
    // Express-style routers.
    if (/\.[cm]?[jt]sx?$/.test(f.path) && /\b(express|fastify|hono|koa|Router)\b/.test(f.text)) {
      const globalAuth = f.lines.findIndex((l) => /\b(app|router|server)\.use\(\s*(?:['"`][^'"`]*['"`]\s*,\s*)?\w*(auth|Auth|jwt|session|passport|protect|requireUser)/.test(l));
      f.lines.forEach((line, i) => {
        const m = line.match(/\b(app|router|server|api|\w+Router)\.(get|post|put|patch|delete|all)\(\s*['"`]([^'"`]+)['"`]\s*,?(.*)$/);
        if (!m) return;
        frameworks.add('express-style');
        const handlerHead = f.lines.slice(i, i + 15).join('\n');
        const inline = AUTH.test(m[4]) || /\b(auth|Auth|requireUser|protect|jwt|verify\w*)\b/.test(m[4]);
        const inner = authIn(handlerHead);
        const auth = inline ? { status: 'found', kind: 'route middleware', ref: ref(f, i) }
          : globalAuth >= 0 && globalAuth < i ? { status: 'found', kind: 'router-level middleware', ref: ref(f, globalAuth) }
          : inner ? { status: 'found', kind: inner.kind, ref: ref(f, i + inner.line) } : { status: 'none-found' };
        items.push({ framework: 'express-style', method: m[2].toUpperCase(), path: m[3], file: f.path, line: i + 1, auth, test: f.test || undefined });
      });
    }
    // FastAPI and Flask.
    if (f.path.endsWith('.py')) {
      const routerDeps = new Map();
      f.lines.forEach((line, i) => {
        const r = line.match(/^(\w+)\s*=\s*(APIRouter|FastAPI)\((.*)/);
        if (r) {
          const head = f.lines.slice(i, i + 6).join(' ');
          if (/dependencies\s*=\s*\[[^\]]*Depends\(/.test(head) && AUTH.test(head)) routerDeps.set(r[1], i);
        }
      });
      f.lines.forEach((line, i) => {
        const fa = line.match(/^\s*@(\w+)\.(get|post|put|patch|delete|api_route|websocket)\(\s*["']([^"']+)["'](.*)/);
        const fl = line.match(/^\s*@(\w+)\.route\(\s*["']([^"']+)["'](.*)/);
        if (!fa && !fl) return;
        frameworks.add(fa ? 'fastapi' : 'flask');
        const decoratorArgs = fa ? fa[4] : fl[3];
        let defIdx = i + 1;
        while (defIdx < f.lines.length && !/^\s*(async\s+)?def\s/.test(f.lines[defIdx])) defIdx++;
        // Other decorators stacked on the same function (above or below the route one).
        let top = i;
        while (top > 0 && /^\s*@/.test(f.lines[top - 1])) top--;
        const decorators = f.lines.slice(top, defIdx).filter((l, k) => top + k !== i).join('\n');
        let sigEnd = defIdx;
        while (sigEnd < f.lines.length && !/\)\s*(->\s*[^:]+)?:\s*$/.test(f.lines[sigEnd]) && sigEnd < defIdx + 12) sigEnd++;
        const sig = f.lines.slice(defIdx, sigEnd + 1).join('\n');
        const indent = (f.lines[defIdx] || '').match(/^\s*/)[0].length;
        let bodyEndIdx = sigEnd + 1;
        while (bodyEndIdx < f.lines.length && bodyEndIdx < sigEnd + 40) {
          const l = f.lines[bodyEndIdx];
          if (l.trim() && l.match(/^\s*/)[0].length <= indent) break;
          bodyEndIdx++;
        }
        const bodyLines = f.lines.slice(sigEnd + 1, bodyEndIdx);
        const router = fa ? fa[1] : fl[1];
        let auth = { status: 'none-found' };
        if (AUTH.test(decoratorArgs)) auth = { status: 'found', kind: 'route decorator dependencies', ref: ref(f, i) };
        else if (AUTH.test(decorators)) auth = { status: 'found', kind: 'decorator', ref: ref(f, top + f.lines.slice(top, defIdx).findIndex((l) => AUTH.test(l))) };
        else if (AUTH.test(sig)) auth = { status: 'found', kind: 'Depends() in signature', ref: ref(f, defIdx + sig.split('\n').findIndex((l) => AUTH.test(l))) };
        else if (routerDeps.has(router)) auth = { status: 'found', kind: 'router dependencies', ref: ref(f, routerDeps.get(router)) };
        else {
          const k = bodyLines.findIndex((l) => !isComment(l) && (AUTH.test(l) || HEADER_CHECK.test(l)));
          if (k >= 0) auth = { status: 'found', kind: 'check in handler body', ref: ref(f, sigEnd + 1 + k) };
        }
        const method = fa ? fa[2].toUpperCase() : ((fl[3].match(/methods\s*=\s*\[([^\]]+)\]/)?.[1] || 'GET').replace(/["'\s]/g, '').replace(/,/g, '|'));
        items.push({ framework: fa ? 'fastapi' : 'flask', method, path: fa ? fa[3] : fl[2], file: f.path, line: i + 1, auth, test: f.test || undefined });
      });
    }
  }
  const mw = middleware ? { file: middleware.file, matchers: middleware.matchers, hasAuth: middleware.hasAuth, cookieOnly: middleware.cookieOnly, authRef: middleware.authRef } : null;
  return { frameworks: [...frameworks], middleware: mw, items, serverActions };
}
