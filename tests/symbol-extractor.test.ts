import { describe, expect, it } from 'vitest';
import { detectLanguage, extractSymbols } from '../packages/repository-index/src/symbol-extractor';
import { SymbolStore, type DbClient } from '../packages/repository-index/src/repository-store';
import type { SymbolRecord, SymbolType } from '../packages/repository-index/src/types';

describe('detectLanguage', () => {
  it('maps extensions to language ids', () => {
    expect(detectLanguage('src/index.ts')).toBe('typescript');
    expect(detectLanguage('app.py')).toBe('python');
    expect(detectLanguage('main.go')).toBe('go');
    expect(detectLanguage('schema.sql')).toBe('sql');
    expect(detectLanguage('README.md')).toBe('markdown');
  });
});

describe('extractSymbols', () => {
  it('extracts TS declarations, class members, imports, extends/implements, and CALLS edges', () => {
    const result = extractSymbols('src/index.ts', [
      "import { foo } from './foo';",
      'export class Greeter extends Base implements Iface {',
      '  greet(name: string): string { return this.speak(name); }',
      '  private speak(n: string): string { return this.wave(); }',
      '  wave(): void {}',
      '}',
      'export const handler = (req: unknown) => { helper(req); };',
      'export function helper(x: number): number { return x + 1; }',
    ].join('\n'));

    const byName = (name: string) => result.symbols.filter((s) => s.name === name);
    expect(byName('Greeter')[0]?.type).toBe('class');
    expect(byName('handler')[0]?.type).toBe('function');
    expect(byName('helper')[0]?.type).toBe('function');
    expect(result.symbols.some((s) => s.name === 'greet' && s.type === 'method')).toBe(true);
    expect(result.symbols.some((s) => s.name === 'speak' && s.type === 'method')).toBe(true);

    expect(result.edges.some((e) => e.source === 'Greeter' && e.target === 'Base' && e.relationship === 'EXTENDS')).toBe(true);
    expect(result.edges.some((e) => e.source === 'Greeter' && e.target === 'Iface' && e.relationship === 'IMPLEMENTS')).toBe(true);
    expect(result.edges.some((e) => e.relationship === 'IMPORTS' && e.target === './foo')).toBe(true);
    expect(result.edges.some((e) => e.source === 'greet' && e.target === 'speak' && e.relationship === 'CALLS')).toBe(true);
    expect(result.edges.some((e) => e.source === 'handler' && e.target === 'helper' && e.relationship === 'CALLS')).toBe(true);
  });

  it('extracts Python declarations and respects indentation', () => {
    const result = extractSymbols('src/app.py', [
      'class Base:',
      '    def greet(self):',
      '        print("hi")',
      'def helper():',
      '    return 1',
    ].join('\n'));
    expect(result.symbols.some((s) => s.name === 'Base' && s.type === 'class')).toBe(true);
    expect(result.symbols.some((s) => s.name === 'greet' && s.type === 'function')).toBe(true);
    expect(result.symbols.some((s) => s.name === 'helper' && s.type === 'function')).toBe(true);
    const base = result.symbols.find((s) => s.name === 'Base');
    expect(base).toBeTruthy();
    expect(base?.endLine).toBeGreaterThan(base?.startLine ?? 0);
  });

  it('extracts SQL declarations', () => {
    const result = extractSymbols('schema.sql', 'CREATE TABLE IF NOT EXISTS users (id INTEGER, name TEXT);\nCREATE VIEW user_names AS SELECT name FROM users;');
    expect(result.symbols.some((s) => s.name === 'users' && s.type === 'schema')).toBe(true);
    expect(result.symbols.some((s) => s.name === 'user_names' && s.type === 'schema')).toBe(true);
  });

  it('extracts Go declarations', () => {
    const result = extractSymbols('main.go', [
      'package main',
      'type User struct {',
      '  Name string',
      '}',
      'func (u *User) Hello(name string) string {',
      '  return "hi"',
      '}',
      'func main() { Hello("x") }',
    ].join('\n'));
    expect(result.symbols.some((s) => s.name === 'User' && s.type === 'type')).toBe(true);
    expect(result.symbols.some((s) => s.name === 'Hello' && s.type === 'method')).toBe(true);
        expect(result.symbols.some((s) => s.name === 'main' && s.type === 'function')).toBe(true);
  });
});

function makeInMemoryStore() {
  const symbols: SymbolRecord[] = [];
  const db: DbClient = {
    async query<T = unknown>(sql: string, params?: unknown[]): Promise<{ rows: T[] }> {
      if (/^INSERT INTO code_symbols/.test(sql)) {
        const [id, rid, filePath, lang, name, type, sig, s, e, summary, hash] = params as unknown[];
        symbols.push({
          id: id as string, repositoryId: rid as string, filePath: filePath as string, language: lang as string,
          symbolName: name as string, symbolType: type as SymbolType, signature: sig ? (sig as string) : undefined,
          startLine: s as number, endLine: e as number, summary: summary ? (summary as string) : undefined, contentHash: hash as string,
        });
        return { rows: [] as T[] };
      }
      if (/^INSERT INTO (symbol_edges|repository_files)/.test(sql) || /^DELETE/.test(sql)) {
        return { rows: [] as T[] };
      }
      if (/^SELECT/.test(sql) && sql.includes('FROM code_symbols')) {
        const repo = params?.[0] as string;
        const name = params?.[1] as string;
        const matched = symbols.filter((r) => r.repositoryId === repo && r.symbolName === name);
        return { rows: matched.map((r) => ({
          id: r.id, repository_id: r.repositoryId, file_path: r.filePath, language: r.language,
          symbol_name: r.symbolName, symbol_type: r.symbolType, signature: r.signature ?? null,
          start_line: r.startLine, end_line: r.endLine, summary: r.summary ?? null, content_hash: r.contentHash,
        })) as unknown as T[] };
      }
      return { rows: [] as T[] };
    },
  };
  return { store: new SymbolStore(db, 'repo-1'), symbols };
}

describe('SymbolStore (in-memory DbClient)', () => {
  it('round-trips a symbol through upsert + findSymbolsByName', async () => {
    const { store, symbols } = makeInMemoryStore();
    const id = store.symbolId('src/a.ts', 'greet', 'function', 1);
    await store.upsertSymbol({
      id, repositoryId: store.repositoryId, filePath: 'src/a.ts', language: 'typescript',
      symbolName: 'greet', symbolType: 'function', startLine: 1, endLine: 3, signature: 'greet()',
      summary: undefined, contentHash: 'abc123', edges: [],
    });
    const found = await store.findSymbolsByName('greet');
    expect(found).toHaveLength(1);
    expect(found[0].symbolName).toBe('greet');
    expect(found[0].startLine).toBe(1);
    expect(symbols[0].symbolType).toBe('function');
  });
});