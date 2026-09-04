import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import {
  buildTenantScopePredicate,
  KnowledgeIngestionService,
  RagService,
  suggestDomain,
  validateLicenseStatement,
} from '@dacai-local-agent/rag';

describe('domain suggestion', () => {
  it.each([
    ['computer-science', 'This compares algorithmic complexity for a data structure and a compiler theory model.'],
    ['backend-development', 'The API gateway coordinates a database transaction through a message queue.'],
    ['frontend-development', 'A React component uses CSS grid and browser rendering accessibility checks.'],
    ['biology', 'Gene expression changes a metabolic pathway at the cell membrane.'],
    ['chemistry', 'Chemical equilibrium and chemical kinetics constrain the reaction mechanism.'],
    ['mathematics', 'A differential equation is solved with numerical integration and linear algebra.'],
    ['physics', 'Lagrangian mechanics and conservation of momentum are checked with statistical mechanics.'],
    ['astrophysics', 'Stellar evolution and galactic dynamics affect the observed spectral redshift.'],
    ['aerospace-engineering', 'Flight dynamics couples an airframe structure to an aerodynamic coefficient.'],
    ['nanotechnology', 'Atomic force microscopy characterizes a nanostructured material and quantum dot.'],
    ['claytronics', 'A catom ensemble uses distributed shape formation for programmable matter.'],
    ['spatial-edge-technology', 'Low latency perception uses an edge inference accelerator and spatial map synchronization.'],
    ['nuclear-technology', 'Neutron transport and reactor thermal hydraulics inform radiation shielding.'],
  ] as const)('classifies distinctive %s material conservatively', (expected, content) => {
    expect(suggestDomain(content)?.domainId).toBe(expected);
  });

  it('abstains when only one hint is present', () => {
    expect(suggestDomain('This document mentions reentrancy once.')).toBeUndefined();
  });

  it('abstains on an equal top-score tie instead of choosing registry order', () => {
    expect(suggestDomain('Solidity reentrancy and consensus mempool are compared.')).toBeUndefined();
  });
});

describe('knowledge-ingestion license policy', () => {
  it.each([
    '',
    'unknown',
    'unspecified',
    'unlicensed',
    'all rights reserved',
    'proprietary',
    'not licensed by owner',
    'permission denied by publisher',
    'publicly accessible web page',
    'custom label',
    'Created by an unrelated third party',
    'Authored by J. R. R. Tolkien',
    'Owned by Acme Corp',
    'Acme-internal-original',
    42,
  ]) (
    'rejects a non-grant placeholder: %s',
    (license) => expect(validateLicenseStatement(license).accepted).toBe(false),
  );

  it.each([
    'CC-BY-4.0',
    'Apache-2.0',
    '0BSD',
    'BlueOak-1.0.0',
    'Python-2.0',
    '(MIT OR Apache-2.0)',
    'GPL-2.0-only WITH Classpath-exception-2.0',
    'public-domain',
    'DACAIS-internal-original',
    'Permission granted by the document owner for local retrieval use',
  ])('accepts an explicit license or permission statement: %s', (license) => {
    expect(validateLicenseStatement(license)).toMatchObject({ accepted: true, normalized: license });
  });

  it('enforces the same policy at the direct RagService boundary before embedding or storage', async () => {
    const embed = vi.fn(async () => [0]);
    const upsertDocument = vi.fn(async () => undefined);
    const rag = new RagService({ embed } as never, { upsertDocument } as never);
    const base = {
      source: 'owner-notes.md',
      sourceId: 'source-owner-notes',
      content: 'licensed content',
      tags: [],
      contentHash: 'a'.repeat(64),
    };

    await expect(rag.ingest({ ...base, license: undefined as never })).rejects.toThrow(/license|permission/i);
    await expect(rag.ingest({ ...base, license: 'not licensed by owner' })).rejects.toThrow(/permission/i);
    expect(embed).not.toHaveBeenCalled();
    expect(upsertDocument).not.toHaveBeenCalled();
  });

  it('rejects a correctly shaped digest that does not match the ingested bytes', async () => {
    const embed = vi.fn(async () => [0]);
    const upsertDocument = vi.fn(async () => undefined);
    const rag = new RagService({ embed } as never, { upsertDocument } as never);
    await expect(rag.ingest({
      source: 'owner-notes.md',
      sourceId: 'source-owner-notes',
      content: 'licensed content',
      tags: [],
      license: 'CC-BY-4.0',
      contentHash: createHash('sha256').update('different bytes').digest('hex'),
    })).rejects.toThrow(/does not match/i);
    expect(embed).not.toHaveBeenCalled();
    expect(upsertDocument).not.toHaveBeenCalled();
  });

  it('accepts exact content integrity and forwards immutable retrieval provenance', async () => {
    const embed = vi.fn(async () => [0]);
    const upsertDocument = vi.fn(async () => undefined);
    const rag = new RagService({ embed } as never, { upsertDocument } as never);
    const content = 'licensed content';
    const stored = await rag.ingest({
      source: 'owner-notes.md',
      sourceId: 'source-owner-notes',
      content,
      tags: [],
      license: 'CC-BY-4.0',
      contentHash: createHash('sha256').update(content).digest('hex'),
    });
    expect(stored).toMatchObject({ sourceId: 'source-owner-notes', license: 'CC-BY-4.0', trainingEligible: false });
    expect(embed).toHaveBeenCalledTimes(1);
    expect(upsertDocument).toHaveBeenCalledWith(expect.objectContaining({ id: stored.id }), [[0]]);
  });
});

describe('tenant-safe retrieval predicates', () => {
  it('binds all four dimensions so an omitted scope can see only global rows', () => {
    const predicate = buildTenantScopePredicate({});
    expect(predicate.values).toEqual([null, null, null, null]);
    expect(predicate.filters).toHaveLength(4);
    expect(predicate.filters).toEqual(expect.arrayContaining([
      expect.stringContaining('d.workspace_id IS NULL OR ($2::text IS NOT NULL'),
      expect.stringContaining('d.engagement_id IS NULL OR ($3::text IS NOT NULL'),
      expect.stringContaining('d.agent_id IS NULL OR ($4::text IS NOT NULL'),
      expect.stringContaining('d.organization_id IS NULL OR ($5::text IS NOT NULL'),
    ]));
  });

  it('binds exact requested values without widening another dimension', () => {
    expect(buildTenantScopePredicate({ organizationId: 'org-a', workspaceId: 'workspace-a' }).values)
      .toEqual(['workspace-a', null, null, 'org-a']);
  });
});

describe('tenant-safe duplicate detection', () => {
  it('matches duplicate content only within identical provenance and tenant scope', async () => {
    const query = vi.fn(async (sql: string) => {
      if (sql.includes('SELECT id FROM knowledge_documents')) return { rows: [] };
      if (sql.includes('SELECT count(*)')) return { rows: [{ count: '1' }] };
      return { rows: [] };
    });
    const ingest = vi.fn(async (doc: Record<string, unknown>) => ({ ...doc, id: 'doc-local' }));
    const service = new KnowledgeIngestionService({ ingest } as never, { query } as never);

    const result = await service.ingest({
      source: 'tenant-notes.md',
      content: 'Gene expression and metabolic pathway evidence.',
      format: 'md',
      license: 'CC-BY-4.0',
      domainId: 'biology',
      organizationId: 'org-a',
      workspaceId: 'workspace-a',
      engagementId: 'engagement-a',
      agentId: 'agent-a',
      availableAt: '2026-01-01T00:00:00.000Z',
    });

    expect(result.status).toBe('ingested');
    const duplicateLookup = query.mock.calls.find(([sql]) => String(sql).includes('SELECT id FROM knowledge_documents'));
    expect(duplicateLookup?.[0]).toMatch(/organization_id IS NOT DISTINCT FROM/);
    expect(duplicateLookup?.[0]).toMatch(/workspace_id IS NOT DISTINCT FROM/);
    expect(duplicateLookup?.[1]).toEqual(expect.arrayContaining([
      'CC-BY-4.0', 'biology', 'org-a', 'workspace-a', 'engagement-a', 'agent-a',
    ]));
    expect(ingest).toHaveBeenCalledTimes(1);
  });

  it('returns an existing id only when the scoped duplicate lookup matches', async () => {
    const query = vi.fn(async (sql: string) => {
      if (sql.includes('SELECT id FROM knowledge_documents')) return { rows: [{ id: 'doc-same-scope' }] };
      return { rows: [] };
    });
    const ingest = vi.fn();
    const service = new KnowledgeIngestionService({ ingest } as never, { query } as never);
    const result = await service.ingest({
      source: 'tenant-notes.md',
      content: 'Gene expression and metabolic pathway evidence.',
      format: 'md',
      license: 'CC-BY-4.0',
      domainId: 'biology',
      organizationId: 'org-a',
      workspaceId: 'workspace-a',
    });
    expect(result).toMatchObject({ status: 'duplicate', documentId: 'doc-same-scope' });
    expect(ingest).not.toHaveBeenCalled();
  });
});
