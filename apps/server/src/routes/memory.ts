import type { FastifyInstance } from 'fastify';
import { MemoryStore, type MemoryScope } from '@dacai-local-agent/memory';

const VALID_SCOPES: MemoryScope[] = ['conversation', 'workspace', 'agent', 'global'];

function isValidScope(value: unknown): value is MemoryScope {
  return typeof value === 'string' && (VALID_SCOPES as string[]).includes(value);
}

interface SaveMemoryBody {
  scope: string;
  scopeKey?: string;
  content: string;
  metadata?: Record<string, unknown>;
}

/**
 * Manual save/list API for durable memory — explicit, not automatic
 * extraction from conversations (that's a separate, larger feature).
 */
export function registerMemoryRoutes(server: FastifyInstance): void {
  const memory = new MemoryStore();

  server.post<{ Body: SaveMemoryBody }>('/api/memory', async (request, reply) => {
    const body = request.body;
    if (!isValidScope(body?.scope)) {
      return reply.code(400).send({ error: `scope must be one of: ${VALID_SCOPES.join(', ')}.` });
    }
    if (!body.content?.trim()) {
      return reply.code(400).send({ error: 'content is required.' });
    }
    if (body.scope !== 'global' && !body.scopeKey?.trim()) {
      return reply.code(400).send({ error: `scope "${body.scope}" requires scopeKey.` });
    }

    const entry = await memory.save({ scope: body.scope, scopeKey: body.scopeKey, content: body.content, metadata: body.metadata });
    return { entry };
  });

  server.get<{ Querystring: { scope?: string; scopeKey?: string; limit?: string } }>('/api/memory', async (request, reply) => {
    const { scope, scopeKey, limit } = request.query;
    if (!isValidScope(scope)) {
      return reply.code(400).send({ error: `scope must be one of: ${VALID_SCOPES.join(', ')}.` });
    }
    if (scope !== 'global' && !scopeKey?.trim()) {
      return reply.code(400).send({ error: `scope "${scope}" requires scopeKey.` });
    }

    const entries = await memory.list(scope, scopeKey, limit ? Number(limit) : undefined);
    return { entries };
  });
}
