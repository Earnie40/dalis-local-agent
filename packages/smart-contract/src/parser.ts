/**
 * A deliberately small Solidity structural reader.
 *
 * This is NOT a compiler front end and does not build an AST. It strips comments
 * and strings, then uses brace matching to isolate function bodies so the
 * detectors in analyzer.ts can reason about "what happens inside this function,
 * in what order" rather than pattern-matching across a whole file.
 *
 * The limitation is real and is reported with every analysis: constructs this
 * reader cannot see (assembly blocks, inherited modifiers defined in another
 * file, library calls) may cause a detector to miss or over-report. Findings are
 * therefore rated with a confidence, and the caller is told what was not parsed.
 */

export interface SolidityFunction {
  name: string;
  /** Raw text between the parentheses. */
  params: string;
  /** Everything between the parameter list and the opening brace. */
  attributes: string;
  body: string;
  /** 1-indexed line where the function signature begins. */
  line: number;
  visibility: 'public' | 'external' | 'internal' | 'private' | 'unspecified';
  stateMutability: 'view' | 'pure' | 'payable' | 'nonpayable';
  modifiers: string[];
  isConstructor: boolean;
}

export interface ParsedContract {
  name?: string;
  functions: SolidityFunction[];
  stateVariables: string[];
  /** True when the source contains assembly, which this reader cannot analyse. */
  hasAssembly: boolean;
  /** Names of base contracts, so "the modifier is inherited" is visible. */
  inherits: string[];
  /** Modifier names defined in this file. */
  definedModifiers: string[];
}

/**
 * Replaces comment and string contents with spaces, preserving byte offsets and
 * line numbers so reported line numbers stay accurate.
 */
export function stripCommentsAndStrings(source: string): string {
  let out = '';
  let i = 0;
  const blank = (text: string) => text.replace(/[^\n]/g, ' ');

  while (i < source.length) {
    const two = source.slice(i, i + 2);
    if (two === '//') {
      const end = source.indexOf('\n', i);
      const stop = end === -1 ? source.length : end;
      out += blank(source.slice(i, stop));
      i = stop;
      continue;
    }
    if (two === '/*') {
      const end = source.indexOf('*/', i + 2);
      const stop = end === -1 ? source.length : end + 2;
      out += blank(source.slice(i, stop));
      i = stop;
      continue;
    }
    const ch = source[i];
    if (ch === '"' || ch === "'") {
      let j = i + 1;
      while (j < source.length && source[j] !== ch) {
        if (source[j] === '\\') j += 1;
        j += 1;
      }
      const stop = Math.min(j + 1, source.length);
      // Keep the quotes so a literal is still syntactically visible.
      out += ch + blank(source.slice(i + 1, stop - 1)) + (source[stop - 1] === ch ? ch : '');
      i = stop;
      continue;
    }
    out += ch;
    i += 1;
  }
  return out;
}

function matchBody(text: string, openBraceIndex: number): { body: string; end: number } | undefined {
  let depth = 0;
  for (let i = openBraceIndex; i < text.length; i += 1) {
    if (text[i] === '{') depth += 1;
    else if (text[i] === '}') {
      depth -= 1;
      if (depth === 0) return { body: text.slice(openBraceIndex + 1, i), end: i };
    }
  }
  return undefined;
}

const FUNCTION_RE = /\b(function\s+([A-Za-z_$][\w$]*)|constructor)\s*\(/g;

export function parseSolidity(source: string): ParsedContract {
  const clean = stripCommentsAndStrings(source);

  const contractMatch = clean.match(/\bcontract\s+([A-Za-z_$][\w$]*)/);
  const inheritsMatch = clean.match(/\bcontract\s+[A-Za-z_$][\w$]*\s+is\s+([^{]+)\{/);

  const functions: SolidityFunction[] = [];
  FUNCTION_RE.lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = FUNCTION_RE.exec(clean)) !== null) {
    const isConstructor = match[1] === 'constructor';
    const openParen = match.index + match[0].length - 1;

    // Balance the parameter list; parameters can contain nested parentheses.
    let depth = 0;
    let closeParen = -1;
    for (let i = openParen; i < clean.length; i += 1) {
      if (clean[i] === '(') depth += 1;
      else if (clean[i] === ')') {
        depth -= 1;
        if (depth === 0) { closeParen = i; break; }
      }
    }
    if (closeParen === -1) continue;

    const brace = clean.indexOf('{', closeParen);
    const semicolon = clean.indexOf(';', closeParen);
    // An interface/abstract declaration ends in ';' with no body.
    if (brace === -1 || (semicolon !== -1 && semicolon < brace)) continue;

    const matched = matchBody(clean, brace);
    if (!matched) continue;

    const attributes = clean.slice(closeParen + 1, brace);
    const modifiers = [...attributes.matchAll(/\b([A-Za-z_$][\w$]*)\s*(?:\([^)]*\))?/g)]
      .map((m) => m[1])
      .filter((name) => !['public', 'external', 'internal', 'private', 'view', 'pure', 'payable', 'virtual', 'override', 'returns', 'memory', 'storage', 'calldata'].includes(name));

    const visibility = (['public', 'external', 'internal', 'private'] as const)
      .find((v) => new RegExp(`\\b${v}\\b`).test(attributes)) ?? 'unspecified';

    const stateMutability = attributes.includes(' view') || /\bview\b/.test(attributes)
      ? 'view'
      : /\bpure\b/.test(attributes)
        ? 'pure'
        : /\bpayable\b/.test(attributes)
          ? 'payable'
          : 'nonpayable';

    functions.push({
      name: isConstructor ? 'constructor' : match[2],
      params: clean.slice(openParen + 1, closeParen),
      attributes,
      body: matched.body,
      line: clean.slice(0, match.index).split('\n').length,
      visibility,
      stateMutability,
      modifiers,
      isConstructor,
    });
  }

  const stateVariables = [...clean.matchAll(/^\s{0,8}(?:mapping\s*\([^;]*\)|uint\d*|int\d*|address|bool|bytes\d*|string)\s+(?:public|private|internal|constant|immutable|\s)*\s*([A-Za-z_$][\w$]*)\s*(?:=|;)/gm)]
    .map((m) => m[1]);

  return {
    name: contractMatch?.[1],
    functions,
    stateVariables,
    hasAssembly: /\bassembly\s*\{/.test(clean),
    inherits: inheritsMatch ? inheritsMatch[1].split(',').map((s) => s.trim().split(/[\s(]/)[0]).filter(Boolean) : [],
    definedModifiers: [...clean.matchAll(/\bmodifier\s+([A-Za-z_$][\w$]*)/g)].map((m) => m[1]),
  };
}
