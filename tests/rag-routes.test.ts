import Fastify from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { registerRagRoutes } from '../apps/server/src/routes/rag';

const servers: ReturnType<typeof Fastify>[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

function makeServer(options: { authorizeScope?: boolean } = {}) {
  const search = vi.fn(async () => [{ id: 'hit-1' }]);
  const ingest = vi.fn(async () => ({
    status: 'ingested' as const,
    ingestionId: 'ing-1',
    documentId: 'doc-1',
    domainId: 'biology' as const,
    assignedDomain: 'biology' as const,
    classificationMethod: 'explicit' as const,
    contentHash: 'abc',
    chunkCount: 1,
    secretsRedacted: 0,
  }));
  const server = Fastify();
  servers.push(server);
  const authorizeScope = vi.fn(async (requested: {
    organizationId?: string;
    workspaceId?: string;
    engagementId?: string;
    agentId?: string;
  }) => requested);
  registerRagRoutes(server, {
    rag: { search },
    ingestion: { ingest },
    ...(options.authorizeScope === false ? {} : { authorizeScope }),
  });
  return { server, search, ingest, authorizeScope };
}

describe('RAG domain and licensing routes', () => {
  it('exposes the registered domain catalog and honest status', async () => {
    const { server } = makeServer();
    const response = await server.inject({ method: 'GET', url: '/api/rag/domains' });
    expect(response.statusCode).toBe(200);
    const domains = response.json().domains as Array<{ id: string; status: string }>;
    expect(domains).toContainEqual(expect.objectContaining({ id: 'biology', status: 'REGISTERED' }));
    expect(domains).toContainEqual(expect.objectContaining({ id: 'nuclear-technology', status: 'REGISTERED' }));
  });

  it('routes document writes through audited ingestion with license and domain provenance', async () => {
    const { server, ingest } = makeServer();
    const response = await server.inject({
      method: 'POST',
      url: '/api/rag/documents',
      payload: {
        source: 'lab-notes.md',
        content: 'Gene expression and metabolic pathway notes.',
        format: 'md',
        license: 'CC-BY-4.0',
        domainId: 'biology',
        organizationId: 'org-1',
      },
    });
    expect(response.statusCode).toBe(200);
    expect(ingest).toHaveBeenCalledWith(expect.objectContaining({
      source: 'lab-notes.md',
      license: 'CC-BY-4.0',
      domainId: 'biology',
      organizationId: 'org-1',
    }));
    expect(response.json().ingestion.status).toBe('ingested');
  });

  it('rejects missing licensing and unknown domains before persistence', async () => {
    const { server, ingest } = makeServer();
    const missingLicense = await server.inject({
      method: 'POST',
      url: '/api/rag/documents',
      payload: { source: 'x.md', content: 'content' },
    });
    expect(missingLicense.statusCode).toBe(400);

    const unknownDomain = await server.inject({
      method: 'POST',
      url: '/api/rag/documents',
      payload: { source: 'x.md', content: 'content', license: 'CC0-1.0', domainId: 'alchemy' },
    });
    expect(unknownDomain.statusCode).toBe(400);
    expect(ingest).not.toHaveBeenCalled();
  });

  it('plumbs domain, tenant, time, untagged, and limit scopes into retrieval', async () => {
    const { server, search } = makeServer();
    const response = await server.inject({
      method: 'GET',
      url: '/api/rag/search?q=orbital&domainIds=astrophysics,aerospace-engineering&organizationId=org-1&asOf=2026-01-01T00%3A00%3A00.000Z&includeUntagged=false&limit=9',
    });
    expect(response.statusCode).toBe(200);
    expect(search).toHaveBeenCalledWith('orbital', expect.objectContaining({
      domainIds: ['astrophysics', 'aerospace-engineering'],
      organizationId: 'org-1',
      asOf: '2026-01-01T00:00:00.000Z',
      includeUntaggedDomain: false,
    }), 9);
  });

  it('fails closed on caller-supplied tenant scope without a trusted authorizer', async () => {
    const { server, search, ingest } = makeServer({ authorizeScope: false });
    const write = await server.inject({
      method: 'POST',
      url: '/api/rag/documents',
      payload: { source: 'x.md', content: 'content', license: 'CC0-1.0', organizationId: 'org-other' },
    });
    const read = await server.inject({
      method: 'GET',
      url: '/api/rag/search?q=x&workspaceId=workspace-other',
    });
    expect(write.statusCode).toBe(400);
    expect(read.statusCode).toBe(400);
    expect(ingest).not.toHaveBeenCalled();
    expect(search).not.toHaveBeenCalled();
  });

  it.each([
    { source: 42, content: 'content', license: 'CC0-1.0' },
    { source: 'x.md', content: 42, license: 'CC0-1.0' },
    { source: 'x.md', content: 'content', license: 42 },
    { source: 'x.md', content: 'content', license: 'CC0-1.0', availableAt: '2026-02-30T00:00:00Z' },
  ])('returns 400 for malformed document bodies instead of leaking an internal error', async (payload) => {
    const { server, ingest } = makeServer();
    const response = await server.inject({ method: 'POST', url: '/api/rag/documents', payload });
    expect(response.statusCode).toBe(400);
    expect(ingest).not.toHaveBeenCalled();
  });

  it.each([
    '/api/rag/search?q=x&domainIds=not-a-domain',
    '/api/rag/search?q=x&limit=0',
    '/api/rag/search?q=x&limit=abc',
    '/api/rag/search?q=x&limit=21',
    '/api/rag/search?q=x&asOf=not-a-date',
    '/api/rag/search?q=x&asOf=2026-02-30T00%3A00%3A00Z',
    '/api/rag/search?q=x&asOf=2026-08-21',
    '/api/rag/search?q=x&includeUntagged=maybe',
    '/api/rag/search?q=x&q=y',
    '/api/rag/search?q=x&domainIds=biology&domainIds=chemistry',
  ])('returns 400 for malformed search scope: %s', async (url) => {
    const { server, search } = makeServer();
    const response = await server.inject({ method: 'GET', url });
    expect(response.statusCode).toBe(400);
    expect(search).not.toHaveBeenCalled();
  });
});
