import { and, desc, eq, isNotNull, isNull } from "drizzle-orm";
import { randomUUID } from "node:crypto";

import { getDb, isDatabaseEnabled } from "@/lib/db";
import { agentTasksTable, conversationsTable, messagesTable } from "@/lib/dbSchema";
import { mergeConversationTargetingBlob, parseConversationTargetingBlob } from "@/lib/conversationTargeting";
import type {
  AgentTaskRecord,
  AgentTaskStatus,
  AgentTaskType,
  ChatMessageRecord,
  ChatRole,
  ConversationRecord,
} from "@/lib/types";

export class ConversationsDisabledError extends Error {
  constructor() {
    super("Database is required for conversations. Set USE_DATABASE_JOBS=true and DATABASE_URL.");
    this.name = "ConversationsDisabledError";
  }
}

function requireDb() {
  if (!isDatabaseEnabled()) {
    throw new ConversationsDisabledError();
  }
  return getDb();
}

function nowIso(): string {
  return new Date().toISOString();
}

export function assertConversationsAvailable(): void {
  requireDb();
}

export async function createConversation(title = "New conversation"): Promise<ConversationRecord> {
  const db = requireDb();
  const id = randomUUID();
  const createdAt = nowIso();
  const updatedAt = createdAt;

  await db.insert(conversationsTable).values({
    id,
    title,
    activeJobId: null,
    pendingInputPath: null,
    playerFocusJson: null,
    archivedAt: null,
    createdAt: new Date(createdAt),
    updatedAt: new Date(updatedAt),
  });

  return {
    id,
    title,
    activeJobId: null,
    pendingInputPath: null,
    playerFocus: null,
    processingPresets: null,
    archivedAt: null,
    createdAt,
    updatedAt,
  };
}

export async function listConversations(options?: {
  limit?: number;
  archived?: boolean;
}): Promise<ConversationRecord[]> {
  const db = requireDb();
  const limit = options?.limit ?? 50;
  const archived = options?.archived ?? false;
  const rows = await db
    .select()
    .from(conversationsTable)
    .where(archived ? isNotNull(conversationsTable.archivedAt) : isNull(conversationsTable.archivedAt))
    .orderBy(desc(conversationsTable.updatedAt))
    .limit(limit);

  return rows.map(mapConversationRow);
}

export async function getConversation(id: string): Promise<ConversationRecord | undefined> {
  const db = requireDb();
  const rows = await db.select().from(conversationsTable).where(eq(conversationsTable.id, id)).limit(1);
  const row = rows[0];
  if (!row) {
    return undefined;
  }
  return mapConversationRow(row);
}

export async function updateConversation(
  id: string,
  patch: Partial<
    Pick<
      ConversationRecord,
      | "title"
      | "activeJobId"
      | "pendingInputPath"
      | "playerFocus"
      | "processingPresets"
      | "highlightClipLimit"
      | "archivedAt"
    >
  >,
): Promise<ConversationRecord | undefined> {
  const db = requireDb();
  const updatedAt = nowIso();

  const targetingChange =
    patch.playerFocus !== undefined ||
    patch.processingPresets !== undefined ||
    patch.highlightClipLimit !== undefined;
  let nextPlayerFocusJson: Record<string, unknown> | null | undefined = undefined;
  if (targetingChange) {
    const rows = await db
      .select({ playerFocusJson: conversationsTable.playerFocusJson })
      .from(conversationsTable)
      .where(eq(conversationsTable.id, id))
      .limit(1);
    const currentBlob = rows[0]?.playerFocusJson ?? null;

    nextPlayerFocusJson = mergeConversationTargetingBlob(currentBlob, {
      ...(patch.playerFocus !== undefined ? { playerFocus: patch.playerFocus } : {}),
      ...(patch.processingPresets !== undefined ? { processingPresets: patch.processingPresets } : {}),
      ...(patch.highlightClipLimit !== undefined ? { highlightClipLimit: patch.highlightClipLimit } : {}),
    });
  }

  await db
    .update(conversationsTable)
    .set({
      ...(patch.title !== undefined ? { title: patch.title } : {}),
      ...(patch.activeJobId !== undefined ? { activeJobId: patch.activeJobId } : {}),
      ...(patch.pendingInputPath !== undefined ? { pendingInputPath: patch.pendingInputPath } : {}),
      ...(nextPlayerFocusJson !== undefined ? { playerFocusJson: nextPlayerFocusJson } : {}),
      ...(patch.archivedAt !== undefined
        ? { archivedAt: patch.archivedAt ? new Date(patch.archivedAt) : null }
        : {}),
      updatedAt: new Date(updatedAt),
    })
    .where(eq(conversationsTable.id, id));

  return getConversation(id);
}

export async function deleteConversation(id: string): Promise<boolean> {
  const db = requireDb();
  const existing = await getConversation(id);
  if (!existing) {
    return false;
  }

  await db.delete(messagesTable).where(eq(messagesTable.conversationId, id));
  await db.delete(agentTasksTable).where(eq(agentTasksTable.conversationId, id));
  await db.delete(conversationsTable).where(eq(conversationsTable.id, id));
  return true;
}

export async function appendMessage(params: {
  conversationId: string;
  role: ChatRole;
  content: string;
  metadata?: Record<string, unknown> | null;
  id?: string;
}): Promise<ChatMessageRecord> {
  const db = requireDb();
  const id = params.id ?? randomUUID();
  const createdAt = nowIso();

  await db.insert(messagesTable).values({
    id,
    conversationId: params.conversationId,
    role: params.role,
    content: params.content,
    metadata: params.metadata ?? null,
    createdAt: new Date(createdAt),
  });

  await db
    .update(conversationsTable)
    .set({ updatedAt: new Date(createdAt) })
    .where(eq(conversationsTable.id, params.conversationId));

  return {
    id,
    conversationId: params.conversationId,
    role: params.role,
    content: params.content,
    metadata: params.metadata ?? null,
    createdAt,
  };
}

export async function listMessagesForConversation(conversationId: string): Promise<ChatMessageRecord[]> {
  const db = requireDb();
  const rows = await db
    .select()
    .from(messagesTable)
    .where(eq(messagesTable.conversationId, conversationId))
    .orderBy(messagesTable.createdAt);

  return rows.map((row) => ({
    id: row.id,
    conversationId: row.conversationId,
    role: row.role as ChatRole,
    content: row.content,
    metadata: row.metadata as Record<string, unknown> | null,
    createdAt: row.createdAt.toISOString(),
  }));
}

export async function updateUserMessageContent(params: {
  conversationId: string;
  messageId: string;
  content: string;
}): Promise<ChatMessageRecord | undefined> {
  const db = requireDb();
  const rows = await db
    .select()
    .from(messagesTable)
    .where(and(eq(messagesTable.id, params.messageId), eq(messagesTable.conversationId, params.conversationId)))
    .limit(1);

  const row = rows[0];
  if (!row || row.role !== "user") {
    return undefined;
  }

  const trimmed = params.content.trim();
  if (!trimmed) {
    return undefined;
  }

  const prevMeta = (row.metadata as Record<string, unknown> | null) ?? {};
  const nextMeta: Record<string, unknown> = { ...prevMeta, editedAt: nowIso() };

  await db
    .update(messagesTable)
    .set({
      content: trimmed,
      metadata: nextMeta,
    })
    .where(eq(messagesTable.id, params.messageId));

  await db
    .update(conversationsTable)
    .set({ updatedAt: new Date() })
    .where(eq(conversationsTable.id, params.conversationId));

  const [updatedRow] = await db
    .select()
    .from(messagesTable)
    .where(eq(messagesTable.id, params.messageId))
    .limit(1);

  if (!updatedRow) {
    return undefined;
  }

  return {
    id: updatedRow.id,
    conversationId: updatedRow.conversationId,
    role: updatedRow.role as ChatRole,
    content: updatedRow.content,
    metadata: updatedRow.metadata as Record<string, unknown> | null,
    createdAt: updatedRow.createdAt.toISOString(),
  };
}

export async function listAgentTasksForConversation(conversationId: string): Promise<AgentTaskRecord[]> {
  const db = requireDb();
  const rows = await db
    .select()
    .from(agentTasksTable)
    .where(eq(agentTasksTable.conversationId, conversationId))
    .orderBy(agentTasksTable.createdAt);

  return rows.map(mapAgentTaskRow);
}

function mapConversationRow(row: typeof conversationsTable.$inferSelect): ConversationRecord {
  const { playerFocus, processingPresets, highlightClipLimit } = parseConversationTargetingBlob(row.playerFocusJson);

  return {
    id: row.id,
    title: row.title,
    activeJobId: row.activeJobId ?? null,
    pendingInputPath: row.pendingInputPath ?? null,
    playerFocus,
    processingPresets,
    ...(highlightClipLimit !== undefined ? { highlightClipLimit } : {}),
    archivedAt: row.archivedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function mapAgentTaskRow(row: typeof agentTasksTable.$inferSelect): AgentTaskRecord {
  return {
    id: row.id,
    conversationId: row.conversationId,
    jobId: row.jobId ?? null,
    type: row.type as AgentTaskType,
    status: row.status as AgentTaskStatus,
    progress: row.progress,
    label: row.label,
    detail: row.detail ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export async function upsertAgentTask(params: {
  id: string;
  conversationId: string;
  jobId?: string | null;
  type: AgentTaskType;
  status: AgentTaskStatus;
  progress?: number;
  label: string;
  detail?: string | null;
}): Promise<AgentTaskRecord> {
  const db = requireDb();
  const createdAt = nowIso();
  const updatedAt = createdAt;

  await db
    .insert(agentTasksTable)
    .values({
      id: params.id,
      conversationId: params.conversationId,
      jobId: params.jobId ?? null,
      type: params.type,
      status: params.status,
      progress: params.progress ?? 0,
      label: params.label,
      detail: params.detail ?? null,
      createdAt: new Date(createdAt),
      updatedAt: new Date(updatedAt),
    })
    .onConflictDoUpdate({
      target: agentTasksTable.id,
      set: {
        jobId: params.jobId ?? null,
        status: params.status,
        progress: params.progress ?? 0,
        label: params.label,
        detail: params.detail ?? null,
        updatedAt: new Date(updatedAt),
      },
    });

  const rows = await db.select().from(agentTasksTable).where(eq(agentTasksTable.id, params.id)).limit(1);
  return mapAgentTaskRow(rows[0]!);
}

export async function deleteAgentTasksForJob(conversationId: string, jobId: string): Promise<void> {
  const db = requireDb();
  await db
    .delete(agentTasksTable)
    .where(and(eq(agentTasksTable.conversationId, conversationId), eq(agentTasksTable.jobId, jobId)));
}
