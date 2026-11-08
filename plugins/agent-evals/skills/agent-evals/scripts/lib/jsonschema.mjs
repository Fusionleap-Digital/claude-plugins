// A small JSON Schema checker for the json-schema assertion. Covers the
// keywords agent output schemas use: type, enum, const, properties, required,
// additionalProperties, items, min/maxItems, min/maxLength, pattern,
// minimum/maximum, anyOf, oneOf, allOf, not. Unknown keywords are ignored.

export function validate(schema, value, path = '$') {
  const errors = [];
  check(schema, value, path, errors);
  return errors;
}

function typeOf(v) {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  if (typeof v === 'number') return Number.isInteger(v) ? 'integer' : 'number';
  return typeof v;
}

function typeMatches(want, v) {
  const t = typeOf(v);
  return want === t || (want === 'number' && t === 'integer');
}

function check(s, v, path, errors) {
  if (s === true || s === undefined) return;
  if (s === false) { errors.push(`${path}: not allowed`); return; }
  if (s.type) {
    const types = Array.isArray(s.type) ? s.type : [s.type];
    if (!types.some((t) => typeMatches(t, v))) {
      errors.push(`${path}: expected ${types.join(' or ')}, got ${typeOf(v)}`);
      return;
    }
  }
  if (s.enum && !s.enum.some((e) => JSON.stringify(e) === JSON.stringify(v))) errors.push(`${path}: must be one of ${JSON.stringify(s.enum)}`);
  if ('const' in s && JSON.stringify(s.const) !== JSON.stringify(v)) errors.push(`${path}: must equal ${JSON.stringify(s.const)}`);
  if (typeof v === 'string') {
    if (s.minLength !== undefined && v.length < s.minLength) errors.push(`${path}: shorter than ${s.minLength}`);
    if (s.maxLength !== undefined && v.length > s.maxLength) errors.push(`${path}: longer than ${s.maxLength}`);
    if (s.pattern && !new RegExp(s.pattern, 'u').test(v)) errors.push(`${path}: does not match ${s.pattern}`);
  }
  if (typeof v === 'number') {
    if (s.minimum !== undefined && v < s.minimum) errors.push(`${path}: below ${s.minimum}`);
    if (s.maximum !== undefined && v > s.maximum) errors.push(`${path}: above ${s.maximum}`);
  }
  if (Array.isArray(v)) {
    if (s.minItems !== undefined && v.length < s.minItems) errors.push(`${path}: fewer than ${s.minItems} items`);
    if (s.maxItems !== undefined && v.length > s.maxItems) errors.push(`${path}: more than ${s.maxItems} items`);
    if (s.items) v.forEach((item, i) => check(s.items, item, `${path}[${i}]`, errors));
  }
  if (typeOf(v) === 'object') {
    for (const key of s.required || []) if (!(key in v)) errors.push(`${path}: missing "${key}"`);
    const props = s.properties || {};
    for (const [key, val] of Object.entries(v)) {
      if (key in props) check(props[key], val, `${path}.${key}`, errors);
      else if (s.additionalProperties === false) errors.push(`${path}: unexpected "${key}"`);
      else if (typeof s.additionalProperties === 'object') check(s.additionalProperties, val, `${path}.${key}`, errors);
    }
  }
  if (s.allOf) for (const sub of s.allOf) check(sub, v, path, errors);
  if (s.anyOf && !s.anyOf.some((sub) => validate(sub, v, path).length === 0)) errors.push(`${path}: matches none of anyOf`);
  if (s.oneOf) {
    const n = s.oneOf.filter((sub) => validate(sub, v, path).length === 0).length;
    if (n !== 1) errors.push(`${path}: matches ${n} of oneOf, expected 1`);
  }
  if (s.not && validate(s.not, v, path).length === 0) errors.push(`${path}: must not match "not" schema`);
}
