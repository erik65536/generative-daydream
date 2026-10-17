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
