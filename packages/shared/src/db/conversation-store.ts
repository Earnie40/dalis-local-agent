import { createId } from '../utils';
import { getPool } from './pool';

/**
 * Conversation persistence. Every message is durable before it is streamed to
 * the client, so a refresh, a crash, or a cancelled request never loses history.
 */

export type MessageRole = 'user' | 'assistant' | 'system' | 'tool';

export interface ConversationRecord {
  id: string;
  title: string;
  workspaceId?: string;
  agentId?: string;
  providerInstanceId?: string;
  model?: string;
  createdAt: string;
  updatedAt: string;
  messageCount?: number;
}

export interface MessageRecord {
  id: string;
  conversationId: string;
  role: MessageRole;
  content: string;
  toolCalls?: unknown;
  metadata: Record<string, unknown>;
  createdAt: string;
}

interface ConversationRow {
  id: string;
  title: string;
  workspace_id: string | null;
  agent_id: string | null;
  provider_instance_id: string | null;
  model: string | null;
  created_at: Date;
  updated_at: Date;
  message_count?: string;
}

interface MessageRow {
  id: string;
  conversation_id: string;
  role: MessageRole;
  content: string;
  tool_calls: unknown;
  metadata: Record<string, unknown>;
  created_at: Date;
}

function toConversation(row: ConversationRow): ConversationRecord {
  return {
    id: row.id,
    title: row.title,
    workspaceId: row.workspace_id ?? undefined,
    agentId: row.agent_id ?? undefined,
    providerInstanceId: row.provider_instance_id ?? undefined,
    model: row.model ?? undefined,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    messageCount: row.message_count === undefined ? undefined : Number(row.message_count),
  };
}

function toMessage(row: MessageRow): MessageRecord {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    role: row.role,
    content: row.content,
    toolCalls: row.tool_calls ?? undefined,
    metadata: row.metadata ?? {},
    createdAt: row.created_at.toISOString(),
  };
}

/** First line of the opening message, so a conversation is recognisable in the list. */
export function deriveTitle(firstMessage: string): string {
  const line = firstMessage.trim().split('\n')[0] ?? '';
  const trimmed = line.length > 60 ? `${line.slice(0, 57)}…` : line;
  return trimmed || 'New conversation';
}

export class ConversationStore {
  async list(limit = 50): Promise<ConversationRecord[]> {
    const { rows } = await getPool().query<ConversationRow>(
      `SELECT c.*, count(m.id) AS message_count
         FROM conversations c
         LEFT JOIN messages m ON m.conversation_id = c.id
        GROUP BY c.id
        ORDER BY c.updated_at DESC
        LIMIT $1`,
      [limit],
    );
    return rows.map(toConversation);
  }

  async get(id: string): Promise<ConversationRecord | undefined> {
    const { rows } = await getPool().query<ConversationRow>('SELECT * FROM conversations WHERE id = $1', [id]);
    return rows[0] ? toConversation(rows[0]) : undefined;
  }

  async create(input: {
    title?: string;
    workspaceId?: string;
    agentId?: string;
    providerInstanceId?: string;
    model?: string;
  } = {}): Promise<ConversationRecord> {
    const { rows } = await getPool().query<ConversationRow>(
      `INSERT INTO conversations (id, title, workspace_id, agent_id, provider_instance_id, model)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [
        createId('conv'),
        input.title ?? 'New conversation',
        input.workspaceId ?? null,
        input.agentId ?? null,
        input.providerInstanceId ?? null,
        input.model ?? null,
      ],
    );
    return toConversation(rows[0]);
  }

  async rename(id: string, title: string): Promise<void> {
    await getPool().query('UPDATE conversations SET title = $2, updated_at = now() WHERE id = $1', [id, title]);
  }

  async remove(id: string): Promise<void> {
    await getPool().query('DELETE FROM conversations WHERE id = $1', [id]);
  }

  async messages(conversationId: string): Promise<MessageRecord[]> {
    const { rows } = await getPool().query<MessageRow>(
      'SELECT * FROM messages WHERE conversation_id = $1 ORDER BY created_at, id',
      [conversationId],
    );
    return rows.map(toMessage);
  }

  async appendMessage(input: {
    conversationId: string;
    role: MessageRole;
    content: string;
    toolCalls?: unknown;
    metadata?: Record<string, unknown>;
  }): Promise<MessageRecord> {
    const { rows } = await getPool().query<MessageRow>(
      `INSERT INTO messages (id, conversation_id, role, content, tool_calls, metadata)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [
        createId('msg'),
        input.conversationId,
        input.role,
        input.content,
        input.toolCalls ? JSON.stringify(input.toolCalls) : null,
        JSON.stringify(input.metadata ?? {}),
      ],
    );

    await getPool().query('UPDATE conversations SET updated_at = now() WHERE id = $1', [input.conversationId]);
    return toMessage(rows[0]);
  }

  /** Fills in the streamed text once generation finishes (or is cancelled). */
  async completeMessage(
    id: string,
    content: string,
    metadata: Record<string, unknown> = {},
  ): Promise<void> {
    await getPool().query(
      `UPDATE messages
          SET content = $2,
              metadata = metadata || $3::jsonb
        WHERE id = $1`,
      [id, content, JSON.stringify(metadata)],
    );
  }

  /**
   * Retry drops the last assistant turn so the same user prompt can be
   * regenerated, rather than appending a second answer to the same question.
   */
  async dropLastAssistantMessage(conversationId: string): Promise<void> {
    await getPool().query(
      `DELETE FROM messages
        WHERE id = (
          SELECT id FROM messages
           WHERE conversation_id = $1 AND role = 'assistant'
           ORDER BY created_at DESC, id DESC
           LIMIT 1
        )`,
      [conversationId],
    );
  }
}
