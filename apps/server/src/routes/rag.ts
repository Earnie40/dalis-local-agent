import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  IngestionError,
  KnowledgeIngestionService,
  RagService,
  RetrievalScopeError,
  isStrictIsoTimestamp,
  type IngestFormat,
} from '@dacai-local-agent/rag';
import {
  isDomainId,
  listDomains,
  type DomainId,
} from '@dacai-local-agent/domain-knowledge';

interface KnowledgeBody {
  source: string;
  title?: string;
  content: string;
  tags?: string[];
  format?: IngestFormat;
  /** SPDX identifier, public-domain declaration, or explicit permission statement. */
  license: string;
  domainId?: string;
  organizationId?: string;
  workspaceId?: string;
  engagementId?: string;
  agentId?: string;
  availableAt?: string;
  metadata?: Record<string, unknown>;
}

type TenantScope = Pick<KnowledgeBody, 'organizationId' | 'workspaceId' | 'engagementId' | 'agentId'>;
type ScopeOperation = 'ingest' | 'search';

export interface RagRouteDependencies {
  rag?: Pick<RagService, 'search'>;
  ingestion?: Pick<KnowledgeIngestionService, 'ingest'>;
  /** Derive/authorize tenant scope from trusted server context; caller input alone is never authority. */
  authorizeScope?: (requested: TenantScope, operation: ScopeOperation) => Promise<TenantScope> | TenantScope;
}

const INGEST_FORMATS = new Set<IngestFormat>(['txt', 'md', 'json', 'code']);
const identifier = z.string().trim().min(1).max(200);
const timestamp = z.string().refine(isStrictIsoTimestamp, 'must be a full RFC 3339 timestamp');
const knowledgeBodySchema = z.object({
  source: z.string().trim().min(1).max(2_000),
  title: z.string().trim().min(1).max(1_000).optional(),
  content: z.string().min(1),
  tags: z.array(z.string().trim().min(1).max(200)).max(100).optional(),
  format: z.enum(['txt', 'md', 'json', 'code']).optional(),
  license: z.string().trim().min(1).max(500),
  domainId: z.string().trim().min(1).max(100).optional(),
  organizationId: identifier.optional(),
  workspaceId: identifier.optional(),
  engagementId: identifier.optional(),
  agentId: identifier.optional(),
  availableAt: timestamp.optional(),
  metadata: z.record(z.unknown()).optional(),
}).strict();

const searchQuerySchema = z.object({
  q: z.string().trim().min(1).max(10_000),
  domainIds: z.string().trim().min(1).max(2_000).optional(),
  organizationId: identifier.optional(),
  workspaceId: identifier.optional(),
  engagementId: identifier.optional(),
  agentId: identifier.optional(),
  asOf: timestamp.optional(),
  includeUntagged: z.enum(['true', 'false']).optional(),
  limit: z.string().regex(/^\d+$/).optional(),
}).strict();

function parseDomainIds(value: string | undefined): DomainId[] | undefined {
  if (value === undefined) return undefined;
  const values = [...new Set(value.split(',').map((item) => item.trim()).filter(Boolean))];
  if (!values.length) throw new IngestionError('domainIds must contain at least one domain id.');
  const unknown = values.find((value) => !isDomainId(value));
  if (unknown) throw new IngestionError(`Unknown domain "${unknown}".`);
  return values as DomainId[];
}

function parseLimit(value: string | undefined): number {
  if (value === undefined) return 6;
  if (!/^\d+$/.test(value)) throw new IngestionError('limit must be an integer from 1 through 20.');
  const parsed = Number(value);
  if (parsed < 1 || parsed > 20) throw new IngestionError('limit must be an integer from 1 through 20.');
  return parsed;
}

function parseBoolean(value: string | undefined, name: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (value === 'true') return true;
  if (value === 'false') return false;
  throw new IngestionError(`${name} must be "true" or "false".`);
}

function policyError(error: unknown): boolean {
  return error instanceof IngestionError || error instanceof RetrievalScopeError;
}

function validationMessage(error: z.ZodError): string {
  const detail = error.issues.slice(0, 5).map((issue) => `${issue.path.join('.') || 'request'}: ${issue.message}`).join('; ');
  return `Invalid request. ${detail}`;
}

async function authorizedTenantScope(
  requested: TenantScope,
  operation: ScopeOperation,
  authorizer: RagRouteDependencies['authorizeScope'],
): Promise<TenantScope> {
  if (!Object.values(requested).some((value) => value !== undefined)) return {};
  if (!authorizer) {
    throw new IngestionError('Tenant-scoped RAG access requires a trusted server authorization context.');
  }
  return authorizer(requested, operation);
}

export function registerRagRoutes(
  server: FastifyInstance,
  dependencies: RagRouteDependencies = {},
): void {
  const rag = dependencies.rag ?? new RagService();
  const ingestion = dependencies.ingestion ?? new KnowledgeIngestionService(rag as RagService);

  server.get('/api/rag/domains', async () => ({ domains: listDomains() }));

  server.post<{ Body: unknown }>('/api/rag/documents', async (request, reply) => {
    const parsedBody = knowledgeBodySchema.safeParse(request.body);
    if (!parsedBody.success) return reply.code(400).send({ error: validationMessage(parsedBody.error) });
    const body = parsedBody.data;
    if (body.domainId !== undefined && !isDomainId(body.domainId)) {
      return reply.code(400).send({ error: `Unknown domain "${body.domainId}".` });
    }
    const format = body.format ?? 'md';
    if (!INGEST_FORMATS.has(format)) {
      return reply.code(400).send({ error: `Unsupported format "${String(format)}".` });
    }

    try {
      const scope = await authorizedTenantScope({
        organizationId: body.organizationId,
        workspaceId: body.workspaceId,
        engagementId: body.engagementId,
        agentId: body.agentId,
      }, 'ingest', dependencies.authorizeScope);
      const result = await ingestion.ingest({
        content: body.content,
        format,
        source: body.source.trim(),
        title: body.title?.trim(),
        license: body.license,
        domainId: body.domainId as DomainId | undefined,
        ...scope,
        tags: body.tags ?? [],
        availableAt: body.availableAt,
        metadata: body.metadata,
      });
      if (result.status === 'rejected') {
        return reply.code(400).send({ error: result.rejectionReason, ingestion: result });
      }
      return { ingestion: result };
    } catch (error) {
      const message = policyError(error) && error instanceof Error ? error.message : 'RAG service unavailable.';
      return reply.code(policyError(error) ? 400 : 503).send({ error: message });
    }
  });

  server.get<{ Querystring: unknown }>('/api/rag/search', async (request, reply) => {
    try {
      const parsedQuery = searchQuerySchema.safeParse(request.query);
      if (!parsedQuery.success) return reply.code(400).send({ error: validationMessage(parsedQuery.error) });
      const query = parsedQuery.data;
      const domainIds = parseDomainIds(query.domainIds);
      const limit = parseLimit(query.limit);
      const includeUntaggedDomain = parseBoolean(query.includeUntagged, 'includeUntagged');
      const scope = await authorizedTenantScope({
        organizationId: query.organizationId,
        workspaceId: query.workspaceId,
        engagementId: query.engagementId,
        agentId: query.agentId,
      }, 'search', dependencies.authorizeScope);

      const results = await rag.search(query.q, {
        domainIds,
        ...scope,
        asOf: query.asOf,
        includeUntaggedDomain,
      }, limit);
      return { results };
    } catch (error) {
      const message = policyError(error) && error instanceof Error ? error.message : 'RAG service unavailable.';
      return reply.code(policyError(error) ? 400 : 503).send({ error: message });
    }
  });
}
