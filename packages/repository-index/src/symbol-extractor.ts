import type { CodeEdge, CodeSymbol, ExtractionResult, SymbolType } from './types.js';

/**
 * Syntax-aware-enough symbol extraction (zero runtime dependencies).
 *
 * A full AST parser (e.g. the TypeScript compiler API or tree-sitter) is the
 * long-term upgrade path; this deterministic scanner already understands
 * declaration forms, brace/indent block extent, class members, imports,
 * extends/implements, and within-file call references across the languages the
 * repository primarily uses (TypeScript/JavaScript, Python, Go, SQL).
 *
 * Pure by design: given a file path + source it returns symbols and edges.
 * Persistence is a separate store concern.
 */

export function detectLanguage(filePath: string): string {
  const lower = filePath.toLowerCase();
  const dot = lower.lastIndexOf('.');
  const ext = dot >= 0 ? lower.slice(dot + 1) : '';
  const map: Record<string, string> = {
    ts: 'typescript', tsx: 'typescript', mts: 'typescript', cts: 'typescript',
    js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript',
    py: 'python', go: 'go', sql: 'sql', rs: 'rust', java: 'java', rb: 'ruby',
    c: 'c', h: 'c', cpp: 'cpp', cc: 'cpp', hpp: 'cpp', cs: 'csharp', php: 'php',
        yaml: 'yaml', yml: 'yaml', json: 'json', md: 'markdown', markdown: 'markdown',
    sh: 'shell', bash: 'shell', zsh: 'shell', ps1: 'powershell', kt: 'kotlin',
  };
  return map[ext] ?? 'unknown';
}

interface Line {
  text: string;
  number: number;
}

/** Last line index of a brace-delimited block starting at startIndex. */
function braceEnd(lines: Line[], startIndex: number): number {
  let depth = 0;
  let seen = false;
  for (let i = startIndex; i < lines.length; i += 1) {
    for (const ch of lines[i].text) {
      if (ch === '{') { depth += 1; seen = true; }
      else if (ch === '}') { depth -= 1; if (seen && depth === 0) return i; }
    }
  }
  return lines.length - 1;
}

/** Last line index of an indentation-delimited block for Python-like languages. */
function indentEnd(lines: Line[], startIndex: number): number {
  const indent = leadingWhitespace(lines[startIndex].text).length;
  let end = startIndex;
  for (let i = startIndex + 1; i < lines.length; i += 1) {
    const text = lines[i].text;
    if (!text.trim()) { end = i; continue; }
    if (leadingWhitespace(text).length <= indent) break;
    end = i;
  }
  return end;
}

function leadingWhitespace(text: string): string {
  const m = text.match(/^[ \t]*/);
  return m ? m[0] : '';
}

function lineSignature(trimmed: string): string | undefined {
  const cut = trimmed.split('//')[0].trim();
  if (!cut) return undefined;
  return cut.length <= 180 ? cut : `${cut.slice(0, 177)}…`;
}

interface DeclMatch {
  name: string;
  type: SymbolType;
  signature?: string;
  extendsNames?: string[];
  implementsNames?: string[];
}

/** Anchored top-level declarations for brace-family languages (TS/JS/Go/SQL/generic). */
function matchTopBraceDecl(line: string): DeclMatch | null {
  const asList = (s?: string) => (s ? s.split(',').map((x) => x.trim()).filter(Boolean) : undefined);
  let m: RegExpMatchArray | null;

  m = line.match(/^(?:export\s+)?(?:default\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][A-Za-z0-9_$]*)\b/);
  if (m) {
    const rest = line.slice(m.index !== undefined ? m.index + m[0].length : 0);
    const ext = rest.match(/extends\s+([A-Za-z_$][A-Za-z0-9_$]*)\b/);
    const impl = rest.match(/implements\s+([A-Za-z_$][A-Za-z0-9_$.,\s]*)/);
    return { name: m[1], type: 'class', signature: lineSignature(line), extendsNames: ext ? [ext[1]] : undefined, implementsNames: impl ? asList(impl[1]) : undefined };
  }
  m = line.match(/^(?:export\s+)?interface\s+([A-Za-z_$][A-Za-z0-9_$]*)\b/);
  if (m) {
    const rest = line.slice(m.index !== undefined ? m.index + m[0].length : 0);
    const ext = rest.match(/extends\s+([A-Za-z_$][A-Za-z0-9_$.,\s]*)/);
    return { name: m[1], type: 'interface', signature: lineSignature(line), extendsNames: ext ? asList(ext[1]) : undefined };
  }
  m = line.match(/^(?:export\s+)?(?:const\s+)?enum\s+([A-Za-z_$][A-Za-z0-9_$]*)\b/);
  if (m) return { name: m[1], type: 'enum', signature: lineSignature(line) };
  m = line.match(/^(?:export\s+)?type\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*=/);
  if (m) return { name: m[1], type: 'type', signature: lineSignature(line) };
  m = line.match(/^(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*(\*)?\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*\(/);
  if (m) return { name: m[2], type: 'function', signature: lineSignature(line) };
  m = line.match(/^(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*(?::[^=]+)?=\s*(?:async\s+)?(?:\([^)]*\)|[A-Za-z_$][A-Za-z0-9_$]*)\s*=>/);
  if (m) return { name: m[1], type: 'function', signature: lineSignature(line) };
    m = line.match(/^(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*(?::[^=;]+)?;/);
  if (m) return { name: m[1], type: 'variable', signature: lineSignature(line) };
  return null;
}

const CONTROL_KEYWORDS = new Set([
  'if', 'for', 'while', 'switch', 'return', 'do', 'else', 'catch', 'try',
  'finally', 'function', 'class', 'interface', 'type', 'enum',
]);

/** Class-body member (method/property) detection used only inside a class block. */
function matchClassMember(line: string): { name: string; type: SymbolType; signature?: string } | null {
  const t = line.trim();
  if (!t || CONTROL_KEYWORDS.has(t.split(/\s+/)[0] ?? '') || t.startsWith('//') || t === '}') return null;
  const method = t.match(
    /^(?:(?:public|private|protected|readonly|static|async|abstract|override|@override)\s+)*(?:get\s+|set\s+)?(?:(constructor)|([A-Za-z_$][A-Za-z0-9_$]*))\s*\([^)]*\)\s*[{:]?/,
  );
  if (method) {
    const name = method[1] ? 'constructor' : method[2];
    return { name, type: 'method', signature: lineSignature(t) };
  }
  const prop = t.match(/^(?:(?:public|private|protected|readonly|static)\s+)*([A-Za-z_$][A-Za-z0-9_$]*)\s*(?::\s*[^=;]+)?\s*;?$/);
  if (prop && t.includes(':')) return { name: prop[1], type: 'property', signature: lineSignature(t) };
  return null;
}

/** Top-level declarations for Python. */
function matchPythonDecl(line: string): DeclMatch | null {
  let m = line.match(/^(?:async\s+)?def\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*\(/);
  if (m) return { name: m[1], type: 'function', signature: lineSignature(line) };
  m = line.match(/^class\s+([A-Za-z_$][A-Za-z0-9_$]*)\b/);
  if (m) {
    const open = line.indexOf('(');
    const close = line.lastIndexOf(')');
    const bases = open >= 0 && close > open ? line.slice(open + 1, close).split(',').map((x) => x.trim()).filter(Boolean) : undefined;
    return { name: m[1], type: 'class', signature: lineSignature(line), extendsNames: bases && bases.length ? bases : undefined };
  }
  return null;
}

/** Top-level declarations for Go. */
function matchGoDecl(line: string): { name: string; type: SymbolType; signature?: string } | null {
  let m = line.match(/^func\s*\([^)]*\)\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*\(/);
  if (m) return { name: m[1], type: 'method', signature: lineSignature(line) };
  m = line.match(/^func\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*\(/);
  if (m) return { name: m[1], type: 'function', signature: lineSignature(line) };
    m = line.match(/^type\s+([A-Za-z_$][A-Za-z0-9_$]*)\s+(?:struct|interface|map|\[|func|[A-Za-z_$][A-Za-z0-9_$]*)\b/);
  if (m) return { name: m[1], type: 'type', signature: lineSignature(line) };
  return null;
}

/** Top-level declarations for SQL. */
function matchSqlDecl(line: string): { name: string; type: SymbolType; signature?: string } | null {
  let m = line.match(/^create\s+(?:or\s+replace\s+)?table\s+(?:if\s+not\s+exists\s+)?([A-Za-z0-9_.]+)/i);
  if (m) return { name: m[1], type: 'schema', signature: lineSignature(line) };
  m = line.match(/^create\s+(?:or\s+replace\s+)?view\s+([A-Za-z0-9_.]+)/i);
  if (m) return { name: m[1], type: 'schema', signature: lineSignature(line) };
  m = line.match(/^create\s+type\s+([A-Za-z0-9_.]+)/i);
  if (m) return { name: m[1], type: 'type', signature: lineSignature(line) };
  return null;
}

/** Fallback top-level matcher for brace-family languages without a dedicated parser. */
function matchGenericBraceDecl(line: string): { name: string; type: SymbolType; signature?: string } | null {
  let m = line.match(/^(?:func|fn|function|fun)\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*\(/);
  if (m) return { name: m[1], type: 'function', signature: lineSignature(line) };
  m = line.match(/^(?:class|struct)\s+([A-Za-z_$][A-Za-z0-9_$]*)\b/);
  if (m) return { name: m[1], type: 'class', signature: lineSignature(line) };
  return null;
}

function isCommentOrBlank(line: string, language: string): boolean {
  const t = line.trim();
  if (!t) return true;
  if (t.startsWith('//') || t.startsWith('/*') || t.startsWith('*')) return true;
  if (t.startsWith('#')) return true;
  if (language === 'sql' && t.startsWith('--')) return true;
  return false;
}

/** Identifier char test (A-Za-z0-9_$) used for call-boundary checks without regex. */
function isIdentChar(code: number): boolean {
  return (code >= 65 && code <= 90) || (code >= 97 && code <= 122) || (code >= 48 && code <= 57) || code === 95 || code === 36;
}

/** Returns true if `name` is invoked (followed by optional whitespace and `(`) as a whole word. */
function matchesCall(text: string, name: string): boolean {
  let from = 0;
  for (;;) {
    const idx = text.indexOf(name, from);
    if (idx === -1) return false;
    const before = idx === 0 ? -1 : text.charCodeAt(idx - 1);
    const afterCode = idx + name.length >= text.length ? -1 : text.charCodeAt(idx + name.length);
    if (before === -1 || !isIdentChar(before)) {
      let j = idx + name.length;
      while (j < text.length && (text[j] === ' ' || text[j] === '\t')) j += 1;
      const callCode = j >= text.length ? -1 : text.charCodeAt(j);
      if (callCode === 40 /* ( */ && (afterCode === -1 || !isIdentChar(afterCode))) return true;
    }
        from = idx + 1;
  }
}

function matchTopDecl(line: string, language: string): DeclMatch | null {
  if (language === 'python') return matchPythonDecl(line.trim());
  if (language === 'go') return matchGoDecl(line);
  if (language === 'sql') return matchSqlDecl(line);
  if (language === 'typescript' || language === 'javascript') return matchTopBraceDecl(line);
  return matchGenericBraceDecl(line);
}

/** Within-file call references: for each callable symbol, scan its own lines. */
function detectCalls(
  filePath: string,
  lines: Line[],
  callables: Array<{ name: string; start: number; end: number }>,
): CodeEdge[] {
  const names = callables.map((c) => c.name);
  const edges: CodeEdge[] = [];
  for (const callee of callables) {
    for (let i = callee.start; i <= Math.min(callee.end, lines.length); i += 1) {
      const text = lines[i - 1]?.text ?? '';
      for (const name of names) {
        if (name === callee.name) continue;
        if (matchesCall(text, name)) edges.push({ filePath, source: callee.name, target: name, relationship: 'CALLS', line: i });
      }
    }
  }
  return edges;
}

/** Module import edges for ESM and CommonJS. */
function detectImports(filePath: string, lines: Line[]): CodeEdge[] {
  const edges: CodeEdge[] = [];
  for (const line of lines) {
    let m = line.text.match(/import\s+(?:type\s+)?(?:[^'"\n]+\s+from\s+)?['"]([^'"]+)['"]/);
    if (m) { edges.push({ filePath, source: '<module>', target: m[1], relationship: 'IMPORTS', line: line.number }); continue; }
    m = line.text.match(/require\s*\(\s*['"]([^'"]+)['"]\s*\)/);
    if (m) edges.push({ filePath, source: '<module>', target: m[1], relationship: 'IMPORTS', line: line.number });
  }
  return edges;
}

function sliceSymbol(lines: Line[], start: number, end: number): string {
  return lines.slice(start - 1, end).map((l) => l.text).join('\n');
}

export function extractSymbols(filePath: string, source: string): ExtractionResult {
  const language = detectLanguage(filePath);
  const lines: Line[] = source.split(/\r?\n/).map((t, i) => ({ text: t, number: i + 1 }));
  const symbols: CodeSymbol[] = [];
  const edges: CodeEdge[] = [];
  const callables: Array<{ name: string; start: number; end: number }> = [];

  const emit = (name: string, type: SymbolType, start: number, end: number, extra?: { signature?: string; extendsNames?: string[]; implementsNames?: string[] }) => {
    symbols.push({ filePath, language, name, type, signature: extra?.signature, startLine: start, endLine: end, content: sliceSymbol(lines, start, end) });
    if (extra?.extendsNames?.length) for (const e of extra.extendsNames) edges.push({ filePath, source: name, target: e, relationship: 'EXTENDS', line: start });
    if (extra?.implementsNames?.length) for (const i of extra.implementsNames) edges.push({ filePath, source: name, target: i, relationship: 'IMPLEMENTS', line: start });
  };

  if (language === 'python') {
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i];
      if (isCommentOrBlank(line.text, language)) continue;
      const decl = matchPythonDecl(line.text.trim());
      if (!decl) continue;
      const end = indentEnd(lines, i);
      emit(decl.name, decl.type, line.number, end + 1, { signature: decl.signature, extendsNames: decl.extendsNames });
      if (decl.type === 'function') callables.push({ name: decl.name, start: line.number, end: end + 1 });
    }
  } else {
    let depth = 0;
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i];
      if (isCommentOrBlank(line.text, language)) continue;
      const opens = line.text.split('{').length - 1;
      const closes = line.text.split('}').length - 1;
      const prevDepth = depth;
      depth += opens - closes;
      if (prevDepth !== 0) continue;

      const decl = matchTopDecl(line.text, language);
      if (!decl) continue;

      const end = opens > 0 ? braceEnd(lines, i) : i;
      emit(decl.name, decl.type, line.number, end + 1, { signature: decl.signature, extendsNames: decl.extendsNames, implementsNames: decl.implementsNames });
      if (decl.type === 'function' || decl.type === 'variable') {
        callables.push({ name: decl.name, start: line.number, end: end + 1 });
      }
      if (decl.type === 'class') {
        for (let j = i + 1; j <= end; j += 1) {
          const ml = lines[j].text.trim();
          if (!ml || isCommentOrBlank(lines[j].text, language)) continue;
          const mem = matchClassMember(ml);
          if (!mem) continue;
          const mEnd = ml.includes('{') ? braceEnd(lines, j) : j;
          emit(mem.name, mem.type, j + 1, mEnd + 1, { signature: mem.signature });
          if (mem.type === 'method') callables.push({ name: mem.name, start: j + 1, end: mEnd + 1 });
        }
      }
    }
  }

  for (const e of detectImports(filePath, lines)) edges.push(e);
  for (const e of detectCalls(filePath, lines, callables)) edges.push(e);
  return { symbols, edges };
}