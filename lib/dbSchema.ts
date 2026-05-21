import { index, integer, jsonb, pgTable, text, timestamp, varchar } from "drizzle-orm/pg-core";

export const jobsTable = pgTable("jobs", {
  id: varchar("id", { length: 64 }).primaryKey(),
  stage: varchar("stage", { length: 64 }).notNull(),
  payload: jsonb("payload").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
});

export const highlightsTable = pgTable("highlights", {
  id: varchar("id", { length: 100 }).primaryKey(),
  jobId: varchar("job_id", { length: 64 }).notNull(),
  payload: jsonb("payload").notNull(),
});

export const clipsTable = pgTable("clips", {
  id: varchar("id", { length: 100 }).primaryKey(),
  jobId: varchar("job_id", { length: 64 }).notNull(),
  path: text("path").notNull(),
  payload: jsonb("payload").notNull(),
});

export const conversationsTable = pgTable(
  "conversations",
  {
    id: varchar("id", { length: 64 }).primaryKey(),
    title: text("title").notNull(),
    activeJobId: varchar("active_job_id", { length: 64 }),
    pendingInputPath: text("pending_input_path"),
    playerFocusJson: jsonb("player_focus_json"),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
  },
  (table) => ({
    conversationsUpdatedAtIdx: index("conversations_updated_at_idx").on(table.updatedAt),
    conversationsArchivedAtIdx: index("conversations_archived_at_idx").on(table.archivedAt),
  }),
);

export const messagesTable = pgTable(
  "messages",
  {
    id: varchar("id", { length: 64 }).primaryKey(),
    conversationId: varchar("conversation_id", { length: 64 }).notNull(),
    role: varchar("role", { length: 32 }).notNull(),
    content: text("content").notNull(),
    metadata: jsonb("metadata"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  },
  (table) => ({
    messagesConversationCreatedIdx: index("messages_conversation_id_created_at_idx").on(
      table.conversationId,
      table.createdAt,
    ),
  }),
);

export const agentTasksTable = pgTable(
  "agent_tasks",
  {
    id: varchar("id", { length: 128 }).primaryKey(),
    conversationId: varchar("conversation_id", { length: 64 }).notNull(),
    jobId: varchar("job_id", { length: 64 }),
    type: varchar("type", { length: 32 }).notNull(),
    status: varchar("status", { length: 32 }).notNull(),
    progress: integer("progress").notNull().default(0),
    label: text("label").notNull(),
    detail: text("detail"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
  },
  (table) => ({
    agentTasksConversationIdx: index("agent_tasks_conversation_id_idx").on(table.conversationId),
    agentTasksJobIdx: index("agent_tasks_job_id_idx").on(table.jobId),
  }),
);
