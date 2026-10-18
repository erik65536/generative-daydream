/** Tolerant JSON extraction for model output (fences, think tags, trailing commas, truncation). */

export function stripThinking(text: string): string {
  return text.replace(/<think>[\s\S]*?<\/think>/gi, '').replace(/^[\s\S]*?<\/think>/i, '');
}

/** Find the first balanced top-level JSON object or array in text. */
function findJsonSpan(text: string): string | null {
  const start = text.search(/[{[]/);
  if (start < 0) return null;
  const open = text[start]!;
  const close = open === '{' ? '}' : ']';
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i]!;
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === open || c === (open === '{' ? '[' : '{')) depth++;
    else if (c === close || c === (close === '}' ? ']' : '}')) {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return text.slice(start); // unbalanced (truncated)
}

/** Close any open strings/brackets of a truncated JSON document. */
function closeTruncated(s: string): string {
  const stack: string[] = [];
  let inStr = false;
  let esc = false;
  for (const c of s) {
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === '{') stack.push('}');
    else if (c === '[') stack.push(']');
    else if (c === '}' || c === ']') stack.pop();
  }
  let out = s;
  if (inStr) out += '"';
  out = out.replace(/,\s*$/, '').replace(/:\s*$/, ': null');
  while (stack.length) out += stack.pop();
  return out;
}

function repair(s: string): string {
  return s
    .replace(/,\s*([}\]])/g, '$1') // trailing commas
    .replace(/[“”]/g, '"') // smart quotes outside strings are rare but fatal
    .replace(/\bNaN\b|\bInfinity\b/g, 'null');
}

export function parseModelJson(raw: string): unknown {
  let text = stripThinking(raw).trim();
  const fence = text.match(/```(?:json|JSON)?\s*([\s\S]*?)(?:```|$)/);
  if (fence && fence[1]!.trim().match(/^[{[]/)) text = fence[1]!.trim();
  try {
    return JSON.parse(text);
  } catch {
    /* fall through */
  }
  const span = findJsonSpan(text);
  if (!span) throw new Error('No JSON object found in model output');
  for (const candidate of [span, repair(span), closeTruncated(repair(span))]) {
    try {
      return JSON.parse(candidate);
    } catch {
      /* try next */
    }
  }
  throw new Error(`Could not parse JSON from model output: ${text.slice(0, 200)}`);
}

type JsonSchema = { type?: string | string[]; properties?: Record<string, JsonSchema>; items?: JsonSchema; anyOf?: JsonSchema[]; oneOf?: JsonSchema[]; allOf?: JsonSchema[]; maxLength?: number; maxItems?: number; $ref?: string; $defs?: Record<string, JsonSchema>; definitions?: Record<string, JsonSchema> };

/** Cut text to a limit at a word (or sentence) boundary. */
function clip(s: string, max: number): string {
  if (s.length <= max) return s;
  const cut = s.slice(0, max);
  const sentence = cut.lastIndexOf('. ');
  if (sentence > max * 0.6) return cut.slice(0, sentence + 1);
  const word = cut.lastIndexOf(' ');
  return (word > max * 0.6 ? cut.slice(0, word) : cut).replace(/[\s,;:–-]+$/, '');
}

/**
 * Fit model output to the size limits of its schema: text over a maximum length is shortened at a word
 * boundary and lists over a maximum count lose their extra items. Models (and structured-output modes) do not
 * reliably respect these limits, and asking again for a whole object to shorten a few strings wastes a call.
 */
export function clampToSchema(value: unknown, schema: JsonSchema, root: JsonSchema = schema): unknown {
  if (schema.$ref) {
    const name = schema.$ref.split('/').pop()!;
    const target = root.$defs?.[name] ?? root.definitions?.[name];
    return target ? clampToSchema(value, target, root) : value;
  }
  for (const alt of [...(schema.allOf ?? []), ...(schema.anyOf ?? []), ...(schema.oneOf ?? [])]) {
    const t = alt.type;
    const fits = (typeof value === 'string' && t === 'string') || (Array.isArray(value) && t === 'array') || (value && typeof value === 'object' && !Array.isArray(value) && t === 'object');
    if (fits || alt.$ref) value = clampToSchema(value, alt, root);
  }
  if (typeof value === 'string' && schema.maxLength !== undefined) return clip(value, schema.maxLength);
  if (Array.isArray(value)) {
    const list = schema.maxItems !== undefined ? value.slice(0, schema.maxItems) : value;
    return schema.items ? list.map((v) => clampToSchema(v, schema.items!, root)) : list;
  }
  if (value && typeof value === 'object' && schema.properties) {
    const out: Record<string, unknown> = { ...(value as Record<string, unknown>) };
    for (const [k, sub] of Object.entries(schema.properties)) if (k in out) out[k] = clampToSchema(out[k], sub, root);
    return out;
  }
  return value;
}

export interface LimitViolation {
  path: (string | number)[];
  schema: JsonSchema;
  value: unknown;
  /** What the limit is, in words. */
  limit: string;
}

/** Fields of model output that break their schema's size limits (a list over its count is one violation). */
export function findLimitViolations(value: unknown, schema: JsonSchema, root: JsonSchema = schema, path: (string | number)[] = []): LimitViolation[] {
  if (schema.$ref) {
    const target = root.$defs?.[schema.$ref.split('/').pop()!] ?? root.definitions?.[schema.$ref.split('/').pop()!];
    return target ? findLimitViolations(value, target, root, path) : [];
  }
  const out: LimitViolation[] = [];
  for (const alt of [...(schema.allOf ?? []), ...(schema.anyOf ?? []), ...(schema.oneOf ?? [])]) {
    const t = alt.type;
    const fits = alt.$ref || (typeof value === 'string' && t === 'string') || (Array.isArray(value) && t === 'array') || (value && typeof value === 'object' && !Array.isArray(value) && t === 'object');
    if (fits) out.push(...findLimitViolations(value, alt, root, path));
  }
  if (typeof value === 'string' && schema.maxLength !== undefined && value.length > schema.maxLength)
    out.push({ path, schema, value, limit: `at most ${schema.maxLength} characters (now ${value.length})` });
  else if (Array.isArray(value)) {
    if (schema.maxItems !== undefined && value.length > schema.maxItems) out.push({ path, schema, value, limit: `at most ${schema.maxItems} items (now ${value.length})` });
    else if (schema.items) value.forEach((v, i) => out.push(...findLimitViolations(v, schema.items!, root, [...path, i])));
  } else if (value && typeof value === 'object' && schema.properties)
    for (const [k, sub] of Object.entries(schema.properties)) if (k in (value as object)) out.push(...findLimitViolations((value as Record<string, unknown>)[k], sub, root, [...path, k]));
  return out;
}

/** Set a value inside parsed JSON by path (returns the updated root). */
export function setAtPath(root: unknown, path: (string | number)[], value: unknown): unknown {
  if (!path.length) return value;
  let node = root as Record<string | number, unknown>;
  for (const k of path.slice(0, -1)) node = node[k] as Record<string | number, unknown>;
  node[path[path.length - 1]!] = value;
  return root;
}

/** A sub-schema made self-contained (references resolved), for asking about one field. */
export function resolveRefs(schema: JsonSchema, root: JsonSchema, depth = 0): JsonSchema {
  if (depth > 12) return schema;
  if (schema.$ref) {
    const target = root.$defs?.[schema.$ref.split('/').pop()!] ?? root.definitions?.[schema.$ref.split('/').pop()!];
    return target ? resolveRefs(target, root, depth + 1) : {};
  }
  const out: JsonSchema = { ...schema };
  delete out.$defs;
  delete out.definitions;
  if (out.items) out.items = resolveRefs(out.items, root, depth + 1);
  if (out.properties) out.properties = Object.fromEntries(Object.entries(out.properties).map(([k, v]) => [k, resolveRefs(v, root, depth + 1)]));
  for (const key of ['anyOf', 'oneOf', 'allOf'] as const) if (out[key]) out[key] = out[key]!.map((s) => resolveRefs(s, root, depth + 1));
  return out;
}

export const pathLabel = (path: (string | number)[]) => path.map((k, i) => (typeof k === 'number' ? `[${k}]` : i ? `.${k}` : k)).join('') || '(answer)';

/** JSON Schema keywords OpenAI strict mode (our baseline) rejects or ignores. */
const UNSUPPORTED = ['minLength', 'maxLength', 'default', 'examples', '$schema', 'not', 'if', 'then', 'else', 'dependentRequired', 'dependentSchemas', 'propertyNames', 'patternProperties', 'unevaluatedProperties', 'contentEncoding', 'contentMediaType'];

const lengthNote = (s: JsonSchema & { description?: string; minLength?: number }) => {
  const max = s.maxLength, min = s.minLength;
  if (max === undefined && !min) return s.description;
  const note = max !== undefined ? `at most ${max} characters${min ? `, at least ${min}` : ''}` : `at least ${min} characters`;
  return s.description ? `${s.description} (${note})` : `(${note})`;
};

/**
 * Compile a schema to the strict structured-output subset (OpenAI's is the baseline every provider must meet):
 * every property required (optional ones become nullable, restored by `restoreOptional`), no extra properties,
 * no unsupported keywords. Item counts and number ranges stay enforced; text length limits move into the
 * field's description, where the model plans to them (a hard cap would cut text off mid-sentence).
 */
export function strictSchema(schema: JsonSchema, root: JsonSchema = schema): Record<string, unknown> {
  const walk = (s: JsonSchema): Record<string, unknown> => {
    const src = s as JsonSchema & Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(src)) if (!UNSUPPORTED.includes(k) && k !== '$defs' && k !== 'definitions') out[k] = v;
    if (src.type === 'string' || src.maxLength !== undefined) {
      const d = lengthNote(src as never);
      if (d) out.description = d;
    }
    if ('const' in out) {
      out.enum = [out.const];
      delete out.const;
    }
    if (src.allOf) {
      // Not supported: a single member is merged in, several are dropped (their constraints still validate locally).
      delete out.allOf;
      if (src.allOf.length === 1) Object.assign(out, walk(src.allOf[0]!));
    }
    if (src.anyOf) out.anyOf = src.anyOf.map(walk);
    if (src.oneOf) {
      out.anyOf = src.oneOf.map(walk);
      delete out.oneOf;
    }
    if (src.items) out.items = walk(src.items);
    if (src.type === 'object' || src.properties) {
      const props = src.properties ?? {};
      const required = new Set((src as { required?: string[] }).required ?? []);
      out.properties = Object.fromEntries(Object.entries(props).map(([k, v]) => [k, required.has(k) ? walk(v) : nullable(walk(v))]));
      out.required = Object.keys(props);
      out.additionalProperties = false;
      out.type = 'object';
    }
    return out;
  };
  const nullable = (s: Record<string, unknown>): Record<string, unknown> => {
    if (typeof s.type === 'string' && !s.anyOf && !s.$ref) {
      const r: Record<string, unknown> = { ...s, type: [s.type, 'null'] };
      if (Array.isArray(s.enum)) r.enum = [...(s.enum as unknown[]), null];
      return r;
    }
    return { anyOf: [s, { type: 'null' }] };
  };
  const out = walk(schema);
  const defs = root.$defs ?? root.definitions;
  if (defs) out.$defs = Object.fromEntries(Object.entries(defs).map(([k, v]) => [k, walk(v)]));
  return out;
}

/** Undo the nullable emulation of optional fields: a null where the original schema allowed absence is dropped. */
export function restoreOptional(value: unknown, schema: JsonSchema, root: JsonSchema = schema): unknown {
  if (schema.$ref) {
    const target = root.$defs?.[schema.$ref.split('/').pop()!] ?? root.definitions?.[schema.$ref.split('/').pop()!];
    return target ? restoreOptional(value, target, root) : value;
  }
  for (const alt of [...(schema.anyOf ?? []), ...(schema.oneOf ?? []), ...(schema.allOf ?? [])]) if (alt.properties || alt.items || alt.$ref) value = restoreOptional(value, alt, root);
  if (Array.isArray(value) && schema.items) return value.map((v) => restoreOptional(v, schema.items!, root));
  if (value && typeof value === 'object' && !Array.isArray(value) && schema.properties) {
    const required = new Set((schema as { required?: string[] }).required ?? []);
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (v === null && !required.has(k)) continue;
      out[k] = schema.properties[k] ? restoreOptional(v, schema.properties[k]!, root) : v;
    }
    return out;
  }
  return value;
}
