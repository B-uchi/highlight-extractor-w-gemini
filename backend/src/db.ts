import { createClient } from "@supabase/supabase-js";
import { config } from "./config";

// Service-role client — bypasses RLS, used only by the backend worker.
export const db = createClient(config.supabase.url, config.supabase.serviceRoleKey, {
  auth: { persistSession: false },
});
