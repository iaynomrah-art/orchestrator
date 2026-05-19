import { createClient } from "@supabase/supabase-js";
import "dotenv/config";

const supabaseUrl = process.env.PUBLIC_SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_SECRET_KEY;

if (!supabaseUrl || !supabaseKey) {
  console.warn("⚠️ Supabase URL or Service Key is missing in environment variables!");
}

export const supabase = createClient(supabaseUrl, supabaseKey);
console.log("✅ Supabase client initialized");
