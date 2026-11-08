// YAML loading. Uses the `yaml` package when it is installed (npm install in
// the scripts folder); otherwise a small built-in parser that covers the
// subset the eval files use: block maps and lists, quoted and plain scalars,
// `|` and `>` block text, one-line [flow] and {flow} values, and comments.
// Not supported by the built-in parser: anchors, tags, multi-line quoted or
// plain scalars, multi-line flow values. It fails loudly on those.

let yamlPkg;
try {
  yamlPkg = await import('yaml');
} catch {
  yamlPkg = null;
}

export function parseYaml(text, file = '<input>') {
  if (yamlPkg) return yamlPkg.parse(text);
  try {
    return new MiniYaml(text).parseDocument();
  } catch (err) {
    throw new Error(`${file}: ${err.message} (the built-in YAML parser handles a subset; run "npm install" in the agent-evals scripts folder for full YAML, or use JSON)`);
  }
}

class MiniYaml {
  constructor(text) {
    this.lines = text.replace(/\r\n?/g, '\n').split('\n').map((raw, i) => ({ raw, n: i + 1 }));
    this.i = 0;
  }

  // Next line that carries content, without consuming it.
  peek() {
    while (this.i < this.lines.length) {
      const l = this.lines[this.i];
      const text = stripComment(l.raw);
      if (text.trim() === '' || /^(---|\.\.\.)\s*$/.test(text)) { this.i++; continue; }
      if (l.indent === undefined) {
        l.indent = text.match(/^ */)[0].length;
        if (/^\t/.test(text.slice(l.indent))) throw new Error(`line ${l.n}: tabs are not allowed for indentation`);
        l.text = text.trim();
      }
      return l;
    }
    return null;
  }

  parseDocument() {
    const first = this.peek();
    if (!first) return null;
    const value = this.parseBlock(first.indent);
    const rest = this.peek();
    if (rest) throw new Error(`line ${rest.n}: unexpected indentation`);
    return value;
  }

  parseBlock(indent) {
    const l = this.peek();
    if (!l || l.indent < indent) return null;
    if (isSeqItem(l.text)) return this.parseSeq(l.indent);
    if (findKeySplit(l.text) >= 0) return this.parseMap(l.indent);
    this.i++;
    return parseInline(l.text, l.n);
  }

  parseSeq(indent) {
    const out = [];
    for (let l = this.peek(); l && l.indent === indent && isSeqItem(l.text); l = this.peek()) {
      const rest = l.text.replace(/^-\s?/, '');
      const offset = l.text.length - rest.length;
      if (rest.trim() === '') {
        this.i++;
        const next = this.peek();
        out.push(next && next.indent > indent ? this.parseBlock(next.indent) : null);
      } else if (isSeqItem(rest) || (findKeySplit(rest) >= 0 && !/^[[{"']/.test(rest))) {
        // "- key: value" or "- - x": reparse the rest of the line as a nested block.
        l.indent = indent + offset;
        l.text = rest;
        out.push(this.parseBlock(l.indent));
      } else if (/^[|>][-+]?$/.test(rest.trim())) {
        this.i++;
        out.push(this.blockScalar(rest.trim(), indent));
      } else {
        this.i++;
        out.push(parseInline(rest, l.n));
      }
    }
    return out;
  }

  parseMap(indent) {
    const out = {};
    for (let l = this.peek(); l && l.indent === indent && !isSeqItem(l.text); l = this.peek()) {
      const at = findKeySplit(l.text);
      if (at < 0) throw new Error(`line ${l.n}: expected "key: value"`);
      const key = String(parseInline(l.text.slice(0, at).trim(), l.n));
      const rest = l.text.slice(at + 1).trim();
      this.i++;
      if (rest === '') {
        const next = this.peek();
        if (next && next.indent > indent) out[key] = this.parseBlock(next.indent);
        else if (next && next.indent === indent && isSeqItem(next.text)) out[key] = this.parseSeq(indent);
        else out[key] = null;
      } else if (/^[|>][-+]?$/.test(rest)) {
        out[key] = this.blockScalar(rest, indent);
      } else {
        out[key] = parseInline(rest, l.n);
      }
    }
    return out;
  }

  // Literal (|) or folded (>) text. Lines are taken raw, comments included.
  blockScalar(indicator, parentIndent) {
    const lines = [];
    let blockIndent = null;
    while (this.i < this.lines.length) {
      const raw = this.lines[this.i].raw;
      if (raw.trim() === '') { lines.push(''); this.i++; continue; }
      const ind = raw.match(/^ */)[0].length;
      if (ind <= parentIndent) break;
      if (blockIndent === null) blockIndent = ind;
      if (ind < blockIndent) break;
      lines.push(raw.slice(blockIndent));
      this.i++;
    }
    while (lines.length && lines[lines.length - 1] === '') lines.pop();
    let text;
    if (indicator[0] === '|') text = lines.join('\n');
    else text = lines.reduce((acc, line, idx) => {
      if (idx === 0) return line;
      if (line === '' || /^\s/.test(line)) return `${acc}\n${line}`;
      return acc.endsWith('\n') || acc === '' ? acc + line : `${acc} ${line}`;
    }, '');
    return indicator.endsWith('-') ? text : `${text}\n`;
  }
}

function isSeqItem(text) {
  return text === '-' || text.startsWith('- ');
}

function stripComment(line) {
  let q = null;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) {
      if (c === '\\' && q === '"') i++;
      else if (c === q) q = null;
    } else if (c === '"' || c === "'") {
      if (i === 0 || /[\s:[{,-]/.test(line[i - 1])) q = c;
    } else if (c === '#' && (i === 0 || /\s/.test(line[i - 1]))) {
      return line.slice(0, i).replace(/\s+$/, '');
    }
  }
  return line.replace(/\s+$/, '');
}

// Index of the ":" that ends a mapping key, or -1.
function findKeySplit(text) {
  if (text.startsWith('"') || text.startsWith("'")) {
    const end = closingQuote(text, 0);
    if (end < 0) return -1;
    const rest = text.slice(end + 1);
    return /^\s*:(\s|$)/.test(rest) ? end + 1 + rest.indexOf(':') : -1;
  }
  if (/^[[{]/.test(text)) return -1;
  const m = text.match(/^[^:]*?:(\s|$)/);
  return m ? m[0].lastIndexOf(':') : -1;
}

function closingQuote(text, start) {
  const q = text[start];
  for (let i = start + 1; i < text.length; i++) {
    if (q === '"' && text[i] === '\\') { i++; continue; }
    if (text[i] === q) {
      if (q === "'" && text[i + 1] === "'") { i++; continue; }
      return i;
    }
  }
  return -1;
}

function parseInline(text, n) {
  const t = text.trim();
  if (t.startsWith('[') || t.startsWith('{')) {
    const p = new FlowParser(t, n);
    const v = p.value();
    p.skipWs();
    if (p.i < t.length) throw new Error(`line ${n}: unexpected "${t.slice(p.i)}" after flow value`);
    return v;
  }
  if (t.startsWith('"') || t.startsWith("'")) {
    const end = closingQuote(t, 0);
    if (end !== t.length - 1) throw new Error(`line ${n}: unterminated or multi-line quoted string`);
    return unquote(t, n);
  }
  if (/^[&*!]/.test(t)) throw new Error(`line ${n}: anchors, aliases and tags are not supported`);
  return scalar(t);
}

function unquote(t, n) {
  if (t[0] === "'") return t.slice(1, -1).replace(/''/g, "'");
  try {
    return JSON.parse(t.replace(/\\x([0-9a-fA-F]{2})/g, '\\u00$1').replace(/\t/g, '\\t'));
  } catch {
    throw new Error(`line ${n}: bad escape in double-quoted string`);
  }
}

function scalar(t) {
  if (t === '' || t === '~' || t === 'null' || t === 'Null' || t === 'NULL') return null;
  if (/^(true|True|TRUE)$/.test(t)) return true;
  if (/^(false|False|FALSE)$/.test(t)) return false;
  if (/^[-+]?(\d[\d_]*)(\.\d+)?([eE][-+]?\d+)?$/.test(t)) return Number(t.replace(/_/g, ''));
  if (/^[-+]?\.\d+$/.test(t)) return Number(t);
  return t;
}

class FlowParser {
  constructor(text, n) { this.t = text; this.i = 0; this.n = n; }
  skipWs() { while (this.i < this.t.length && /\s/.test(this.t[this.i])) this.i++; }
  fail(msg) { throw new Error(`line ${this.n}: ${msg} in flow value`); }
  value(stops = ',]}') {
    this.skipWs();
    const c = this.t[this.i];
    if (c === '[') {
      this.i++;
      const out = [];
      for (;;) {
        this.skipWs();
        if (this.t[this.i] === ']') { this.i++; return out; }
        out.push(this.value());
        this.skipWs();
        if (this.t[this.i] === ',') this.i++;
        else if (this.t[this.i] !== ']') this.fail('expected "," or "]"');
      }
    }
    if (c === '{') {
      this.i++;
      const out = {};
      for (;;) {
        this.skipWs();
        if (this.t[this.i] === '}') { this.i++; return out; }
        const key = String(this.value(':,}'));
        this.skipWs();
        if (this.t[this.i] !== ':') this.fail('expected ":"');
        this.i++;
        out[key] = this.value();
        this.skipWs();
        if (this.t[this.i] === ',') this.i++;
        else if (this.t[this.i] !== '}') this.fail('expected "," or "}"');
      }
    }
    if (c === '"' || c === "'") {
      const end = closingQuote(this.t, this.i);
      if (end < 0) this.fail('unterminated string');
      const s = unquote(this.t.slice(this.i, end + 1), this.n);
      this.i = end + 1;
      return s;
    }
    const start = this.i;
    while (this.i < this.t.length) {
      const ch = this.t[this.i];
      // A ":" not followed by a space (as in a URL) is part of the scalar.
      if (ch === ':' && !/\s/.test(this.t[this.i + 1] || ' ')) { this.i++; continue; }
      if (stops.includes(ch)) break;
      this.i++;
    }
    return scalar(this.t.slice(start, this.i).trim());
  }
}
