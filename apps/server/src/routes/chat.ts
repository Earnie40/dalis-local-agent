import type { OutgoingHttpHeaders } from 'node:http';
import type { FastifyInstance } from 'fastify';
import type { AppConfig } from '@dacai-local-agent/shared';
import type { ModelUsage } from '@dacai-local-agent/agent-core';
import { ConversationStore, deriveTitle, UsageStore } from '@dacai-local-agent/shared';
import { sanitizeText } from '@dacai-local-agent/security';
import type { ProviderRegistry } from '@dacai-local-agent/providers';
import { ContextManager } from '@dacai-local-agent/context';
import { beginSessionActivity, touchSessionActivity } from '../session-preflight';

interface ChatBody {
  conversationId?: string;
  message: string;
  alias?: string;
  workspaceId?: string;
  /** Regenerate the last answer instead of appending a new exchange. */
  retry?: boolean;
}

/**
 * Server-Sent Events framing. One `event:` + `data:` pair per message, blank
 * line terminated — the format the browser client parses incrementally.
 */
export function sseFrame(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

/**
 * Headers a hook may set that must survive onto the raw SSE response. Copying
 * every header instead would drag request-shaped entries onto the response.
 */
export const CARRIED_HEADERS = [
  'access-control-allow-origin',
  'access-control-allow-headers',
  'access-control-allow-methods',
  'access-control-allow-credentials',
  'vary',
] as const;

export function registerChatRoutes(
  server: FastifyInstance,
  deps: { config: AppConfig; registry: ProviderRegistry },
): void {
  const conversations = new ConversationStore();
  const usage = new UsageStore();
  const contextManager = new ContextManager();

  server.get('/api/conversations', async () => ({ conversations: await conversations.list() }));

  server.get<{ Params: { id: string } }>('/api/conversations/:id', async (request, reply) => {
    const conversation = await conversations.get(request.params.id);
    if (!conversation) return reply.code(404).send({ error: 'Conversation not found.' });
    return { conversation, messages: await conversations.messages(request.params.id) };
  });

  server.post<{ Body: { title?: string; workspaceId?: string } }>('/api/conversations', async (request) => ({
    conversation: await conversations.create(request.body ?? {}),
  }));

  server.delete<{ Params: { id: string } }>('/api/conversations/:id', async (request) => {
    await conversations.remove(request.params.id);
    return { ok: true };
  });

  /**
   * Streams a reply over SSE.
   *
   * Ordering matters: the user message is persisted and the assistant row is
   * created *before* any token is generated, so a cancelled or crashed stream
   * still leaves a coherent, resumable transcript rather than a dangling prompt.
   */
  server.post<{ Body: ChatBody }>('/api/chat/stream', async (request, reply) => {
    const body = request.body;
    if (!body?.message?.trim() && !body?.retry) {
      return reply.code(400).send({ error: 'message is required.' });
    }

    const alias = body.alias ?? 'chat';
    const sessionKey = body.conversationId ?? `workspace:${body.workspaceId ?? 'default'}`;
    const sessionBoundary = beginSessionActivity(sessionKey);
    const runpodPreflight = await deps.registry.gpuAvailability(sessionBoundary.refreshPreflight);
    let resolved;
    try {
      // Chat is advisory work: no tool calling is required, so an
      // advisory-class model is perfectly legitimate here.
      resolved = await deps.registry.resolveAlias(alias);
    } catch (error) {
      return reply.code(400).send({ error: (error as Error).message });
    }

    const conversation = body.conversationId
      ? await conversations.get(body.conversationId)
      : await conversations.create({
          title: deriveTitle(body.message),
          workspaceId: body.workspaceId,
          providerInstanceId: resolved.instance.id,
          model: resolved.model,
        });

    if (!conversation) return reply.code(404).send({ error: 'Conversation not found.' });

    if (body.retry) {
      await conversations.dropLastAssistantMessage(conversation.id);
    } else {
      await conversations.appendMessage({
        conversationId: conversation.id,
        role: 'user',
        content: body.message,
      });
    }

    const history = await conversations.messages(conversation.id);
    
    // Build unified context using the context manager
    let systemPrompt: string | undefined;
    try {
      const builtContext = await contextManager.buildContext({
        goal: body.message,
        scope: { workspaceId: body.workspaceId },
        conversationHistory: history.map((m) => ({
          role: m.role,
          content: m.content,
        })),
        options: {
          enableRag: process.env.RAG_ENABLED === 'true',
          enableMemory: true,
          maxContextTokens: 26000,
        },
      });
      
      if (builtContext.sections.length > 0) {
        systemPrompt = contextManager.formatContextString(builtContext);
        if (builtContext.truncated) {
          server.log.debug({
            reasoning: builtContext.reasoning,
            totalTokens: builtContext.totalTokens,
          }, 'Context was truncated to fit token limit');
        }
      }
    } catch (error) {
      server.log.warn(
        { error: error instanceof Error ? error.message : String(error) },
        'Context retrieval failed, proceeding without augmented context',
      );
    }
    const assistantMessage = await conversations.appendMessage({
      conversationId: conversation.id,
      role: 'assistant',
      content: '',
      metadata: {
        providerInstanceId: resolved.instance.id,
        usageClass: resolved.instance.usageClass,
        model: resolved.model,
        requestedAlias: alias,
        alias: resolved.alias ?? alias,
        routingNote: resolved.routingNote,
        promotedFromAlias: resolved.promotedFromAlias,
        fellBackFromAlias: resolved.fellBackFromAlias,
        runpodPreflight: runpodPreflight
          ? { refreshed: sessionBoundary.refreshPreflight, ...runpodPreflight }
          : { refreshed: sessionBoundary.refreshPreflight, status: 'unavailable' },
      },
    });

    // reply.raw.writeHead bypasses Fastify's reply entirely, so headers set by
    // hooks — CORS above all — must be carried over explicitly or the browser
    // rejects the response even though it arrives with status 200.
    const sseHeaders: OutgoingHttpHeaders = {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    };

    for (const name of CARRIED_HEADERS) {
      const value = reply.getHeader(name);
      if (typeof value === 'string') sseHeaders[name] = value;
    }

    reply.raw.writeHead(200, sseHeaders);

    // Closing the browser tab or hitting Stop aborts the in-flight HTTP request
    // to Ollama, not merely the loop reading from it.
    //
    // The disconnect signal must come from the RESPONSE, not the request:
    // request.raw emits 'close' (and reports destroyed === true) as soon as its
    // body has been consumed, which happens on every normal request and has
    // nothing to do with the client going away.
    const controller = new AbortController();
    let clientGone = false;
    reply.raw.on('close', () => {
      if (reply.raw.writableEnded) return;
      clientGone = true;
      controller.abort();
    });

    reply.raw.write(
      sseFrame('start', {
        conversationId: conversation.id,
        messageId: assistantMessage.id,
        providerInstanceId: resolved.instance.id,
        usageClass: resolved.instance.usageClass,
        model: resolved.model,
        requestedAlias: alias,
        alias: resolved.alias ?? alias,
        routingNote: resolved.routingNote,
        promotedFromAlias: resolved.promotedFromAlias,
        fellBackFromAlias: resolved.fellBackFromAlias,
      }),
    );

    const startedAt = Date.now();
    let text = '';
    let cancelled = false;
    let failed: string | undefined;
    let usageTokens: Partial<ModelUsage> | undefined;

    try {
      const provider = resolved.provider;
      if (!provider.stream) throw new Error(`Provider "${resolved.instance.id}" does not support streaming.`);

      for await (const event of provider.stream({
        model: resolved.model,
        systemPrompt,
        messages: history.map((message) => ({
          role: message.role === 'tool' ? 'tool' : message.role,
          content: message.content,
        })),
        temperature: resolved.temperature,
        signal: controller.signal,
      })) {
        if (event.type === 'chunk' && event.content) {
          text += event.content;
          reply.raw.write(sseFrame('chunk', { content: event.content }));
        } else if (event.type === 'thinking') {
          // A reasoning model is mid-thought. The client shows an indicator;
          // the reasoning content itself is never sent or stored.
          reply.raw.write(sseFrame('thinking', { content: event.content }));
        } else if (event.type === 'error') {
          failed = event.error;
          break;
        } else if (event.type === 'done') {
          usageTokens = event.usage;
          break;
        }
      }
    } catch (error) {
      if (controller.signal.aborted) cancelled = true;
      else failed = (error as Error).message;
    }

    if (controller.signal.aborted) cancelled = true;
    // The transcript is finalised either way — a stopped answer keeps the text
    // produced up to the stop, marked as stopped rather than discarded.

    const durationMs = Date.now() - startedAt;
    // Secrets are scrubbed on the way into storage, not only on the way out.
    const finalText = sanitizeText(text);

    await conversations.completeMessage(assistantMessage.id, finalText, {
      cancelled,
      error: failed,
      durationMs,
      inputTokens: usageTokens?.inputTokens ?? 0,
      outputTokens: usageTokens?.outputTokens ?? 0,
    });

    await usage.record({
      conversationId: conversation.id,
      workspaceId: body.workspaceId,
      providerInstanceId: resolved.instance.id,
      usageClass: resolved.instance.usageClass,
      model: resolved.model,
      source: 'ui',
      inputTokens: usageTokens?.inputTokens ?? 0,
      outputTokens: usageTokens?.outputTokens ?? 0,
      durationMs,
      fallbackFromInstanceId: resolved.fallbackFromInstanceId,
      providerError: failed,
    });

    if (!clientGone && !reply.raw.writableEnded) {
      reply.raw.write(
        sseFrame(failed ? 'error' : 'done', {
          messageId: assistantMessage.id,
          conversationId: conversation.id,
          cancelled,
          error: failed,
          durationMs,
          usage: usageTokens,
        }),
      );
      reply.raw.end();
    }

    touchSessionActivity(sessionKey);

    return reply;
  });

  /** Usage ledger, split by usage class — the local-vs-remote evidence. */
  server.get('/api/usage', async () => ({ summary: await usage.summary() }));
}
