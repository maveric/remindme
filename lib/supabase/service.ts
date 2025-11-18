import { createClient } from "@supabase/supabase-js";

export function createSupabaseServiceClient() {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!supabaseUrl || !serviceRoleKey) {
    throw new Error(
      "Supabase service client is not configured. Set NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY."
    );
  }

  const isProbablyJwt = serviceRoleKey.split(".").length === 3;

  if (!isProbablyJwt) {
    throw new Error(
      "SUPABASE_SERVICE_ROLE_KEY is not a valid JWT. Copy the `service_role` key from Supabase → Settings → API and paste it here (it should contain two periods)."
    );
  }

  return createClient(supabaseUrl, serviceRoleKey, {
    auth: {
      persistSession: false,
    },
    global: {
      headers: {
        "X-Client-Info": "permit-buddy-admin",
      },
    },
  });
}
