import { describe, expect, it } from 'vitest';
import {
  buildStandaloneStudioDocument,
  buildStudioDocument,
  DEFAULT_STUDIO_FILES,
  parseStudioPreviewMessage,
  STUDIO_IFRAME_SANDBOX,
  STUDIO_MAX_FILE_CHARS,
  STUDIO_MESSAGE_CHANNEL,
  type StudioFiles,
} from '../apps/web/src/studio-sandbox';

describe('Studio browser sandbox document', () => {
  it('places a deny-by-default CSP before authored content and grants only iframe scripts', () => {
    const document = buildStudioDocument(DEFAULT_STUDIO_FILES, 'run-1');
    expect(STUDIO_IFRAME_SANDBOX).toBe('allow-scripts');
    expect(STUDIO_IFRAME_SANDBOX).not.toContain('allow-same-origin');
    expect(document.indexOf('Content-Security-Policy')).toBeLessThan(document.indexOf('charset'));
    expect(document).toContain("default-src 'none'");
    expect(document).toContain("connect-src 'none'");
    expect(document).toContain("frame-src 'none'");
    expect(document).toContain("worker-src 'none'");
    expect(document).toContain('#studio-root { width: 100%; height: 100%');
  });

  it('encodes authored source so closing tags cannot escape the trusted bootstrap', () => {
    const files: StudioFiles = {
      html: '<section>safe</section>',
      css: 'body::after { content: "</style><script>bad()</script>"; }',
      javascript: 'console.log("</script><script>parent.postMessage({pwned:true}, \'*\')</script>");',
    };
    const document = buildStudioDocument(files, 'run-encoded');
    expect(document).not.toContain('<script>parent.postMessage({pwned:true}');
    expect(document).not.toContain('</style><script>bad()');
    expect(document).not.toContain(files.javascript);
    expect(document).toContain('atob(');
  });

  it('preserves Unicode source in a deterministic standalone no-network export', () => {
    const files: StudioFiles = { html: '<p>星</p>', css: 'p { color: gold; }', javascript: 'console.log("🚀")' };
    const first = buildStandaloneStudioDocument(files);
    const second = buildStandaloneStudioDocument(files);
    expect(first).toBe(second);
    expect(first).toContain("connect-src 'none'");
    expect(first).not.toContain(STUDIO_MESSAGE_CHANNEL);
  });

  it('rejects oversized files before constructing a preview', () => {
    expect(() => buildStudioDocument({
      html: 'x'.repeat(STUDIO_MAX_FILE_CHARS + 1),
      css: '',
      javascript: '',
    }, 'run-large')).toThrow(/exceeds/);
  });

  it('accepts only exact, current, bounded console message shapes', () => {
    const valid = {
      channel: STUDIO_MESSAGE_CHANNEL,
      runId: 'run-current',
      type: 'log',
      text: 'ready',
    };
    expect(parseStudioPreviewMessage(valid, 'run-current')).toEqual(valid);
    expect(parseStudioPreviewMessage({ ...valid, runId: 'run-stale' }, 'run-current')).toBeUndefined();
    expect(parseStudioPreviewMessage({ ...valid, type: 'navigate' }, 'run-current')).toBeUndefined();
    expect(parseStudioPreviewMessage({ ...valid, text: 'x'.repeat(4_001) }, 'run-current')).toBeUndefined();
    expect(parseStudioPreviewMessage({ ...valid, command: 'fetch' }, 'run-current')).toBeUndefined();
  });
});
