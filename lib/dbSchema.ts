import { jsonb, pgTable, text, timestamp, varchar } from "drizzle-orm/pg-core";

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
