import { createClient } from "@supabase/supabase-js";

import { appConfig } from "@/lib/config";

// Server-side client — uses service role key (bypasses RLS)
export function createServerClient() {
  const { url, serviceRoleKey } = appConfig.supabase;
  if (!url || !serviceRoleKey) {
    throw new Error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set.");
  }
  return createClient(url, serviceRoleKey, {
    auth: { persistSession: false },
  });
}

// Browser client — uses anon key
let browserClient: ReturnType<typeof createClient> | null = null;
export function getBrowserClient() {
  if (browserClient) return browserClient;
  const { url, anonKey } = appConfig.supabase;
  if (!url || !anonKey) {
    throw new Error("SUPABASE_URL and SUPABASE_ANON_KEY must be set.");
  }
  browserClient = createClient(url, anonKey);
  return browserClient;
}
