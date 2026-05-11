import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import { appConfig } from "@/lib/config";

let dbInstance: ReturnType<typeof drizzle> | null = null;
let sqlInstance: postgres.Sql | null = null;

export function isDatabaseEnabled(): boolean {
  return appConfig.jobs.useDatabase && Boolean(appConfig.jobs.databaseUrl);
}

export function getDb() {
  if (!isDatabaseEnabled()) {
    throw new Error("Database jobs are disabled.");
  }
  if (dbInstance) {
    return dbInstance;
  }

  sqlInstance = postgres(appConfig.jobs.databaseUrl, { max: 2 });
  dbInstance = drizzle(sqlInstance);
  return dbInstance;
}

export async function closeDb(): Promise<void> {
  if (sqlInstance) {
    await sqlInstance.end({ timeout: 2 });
  }
}
