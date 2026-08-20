import type { FastifyInstance } from 'fastify';
import { RagService } from '@dacai-local-agent/rag';

interface KnowledgeBody {
  id?: string;
  source: string;
  title?: string;
  content: string;
  tags?: string[];
  workspaceId?: string;
  engagementId?: string;
  agentId?: string;
  metadata?: Record<string, unknown>;
}

export function registerRagRoutes(server: FastifyInstance): void {
  const rag = new RagService();

  server.post<{ Body: KnowledgeBody }>('/api/rag/documents', async (request, reply) => {
    const body = request.body;
    if (!body?.source?.trim() || !body?.content?.trim()) return reply.code(400).send({ error: 'source and content are required.' });
    try {
      const document = await rag.ingest({ ...body, source: body.source.trim(), content: body.content.trim(), tags: body.tags ?? [] });
      return { document };
    } catch (error) {
      return reply.code(503).send({ error: error instanceof Error ? error.message : 'RAG ingestion failed.' });
    }
  });

  server.get<{ Querystring: { q?: string; workspaceId?: string; engagementId?: string; agentId?: string; limit?: string } }>('/api/rag/search', async (request, reply) => {
    const query = request.query.q?.trim();
    if (!query) return reply.code(400).send({ error: 'q is required.' });
    try {
      const results = await rag.search(query, {
        workspaceId: request.query.workspaceId,
        engagementId: request.query.engagementId,
        agentId: request.query.agentId,
      }, Number(request.query.limit ?? 6));
      return { results };
    } catch (error) {
      return reply.code(503).send({ error: error instanceof Error ? error.message : 'RAG search failed.' });
    }
  });
}
