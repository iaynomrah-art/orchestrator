import { createClient } from "@supabase/supabase-js";
import ws from "ws";
import "dotenv/config";

const supabaseUrl = process.env.PUBLIC_SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_SECRET_KEY;

if (!supabaseUrl || !supabaseKey) {
  console.warn("⚠️ Supabase URL or Service Key is missing in environment variables!");
}

// Errors where the connection was never established, so the request never reached
// Supabase. Retrying these is safe for every method, including inserts.
const CONNECT_ERRORS = new Set([
  "UND_ERR_CONNECT_TIMEOUT", "ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN",
  "ENETUNREACH", "EHOSTUNREACH", "ETIMEDOUT",
]);
const MAX_RETRIES = 2;

/**
 * fetch with retries for network-level failures ("TypeError: fetch failed").
 * - Connection never established: retry any method.
 * - Connection dropped mid-request: retry only reads and idempotent writes
 *   (GET/HEAD/PATCH/PUT/DELETE). A POST (insert) may already have been applied,
 *   so it is not retried.
 */
async function fetchWithRetry(input, init = {}) {
  const method = (init.method || "GET").toUpperCase();
  const idempotent = ["GET", "HEAD", "PATCH", "PUT", "DELETE"].includes(method);

  for (let attempt = 0; ; attempt++) {
    try {
      return await fetch(input, init);
    } catch (err) {
      // Aborts come from the caller's own timeout: not retried, and left to the
      // caller to report (e.g. priceStreamer rate-limits its own error log).
      if (err?.name === "AbortError") throw err;

      const code = err?.cause?.code || err?.code || "unknown";
      const retryable = CONNECT_ERRORS.has(code) || idempotent;
      const url = String(input?.url || input).split("?")[0];
      console.warn(`[supabase fetch] ${method} ${url} failed (${code}: ${err?.cause?.message || err?.message})` +
        (retryable && attempt < MAX_RETRIES ? ` - retry ${attempt + 1}/${MAX_RETRIES}` : " - giving up"));
      if (!retryable || attempt >= MAX_RETRIES) throw err;
      await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
    }
  }
}

export const supabase = createClient(supabaseUrl, supabaseKey, {
  global: { fetch: fetchWithRetry },
  realtime: {
    transport: ws,
  },
});
console.log("✅ Supabase client initialized");
