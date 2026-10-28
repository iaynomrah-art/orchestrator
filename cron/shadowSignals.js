import cron from "node-cron";
import { generateSignal, isSignalInProgress } from "../helper/signalHelper.js";
import { goldMarketOpen, isRollover } from "../helper/marketContextHelper.js";

// Shadow mode: a signal at each of the S/R rule's two times, recorded but never
// traded. cron/gradeSignals.js grades it once it hits SL or TP, next to the
// TradingView rating and a coin flip. Off unless SHADOW_SIGNALS_ENABLED=true.
let running = false;

async function makeShadowSignal() {
  if (process.env.SHADOW_SIGNALS_ENABLED !== "true" || running) return;
  const now = new Date();
  if (!goldMarketOpen(now) || isRollover(now)) return;
  if (isSignalInProgress()) {
    console.log("[shadow] Skipped this hour: a real signal request is running");
    return;
  }
  running = true;
  try {
    // One more try a minute later: a network blip shouldn't cost the hour's signal
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        const { response } = await generateSignal({ symbol: "XAUUSD", timeframe: "1h", shadow: true });
        console.log(`[shadow] ${response.action} score ${response.confidence} (v2 ${response.score_v2}) recorded as ${response.signal_id}`);
        return;
      } catch (error) {
        console.error(`[shadow] Attempt ${attempt}/2 failed: ${error.message}`);
        if (attempt < 2) await new Promise((r) => setTimeout(r, 60000));
      }
    }
  } finally {
    running = false;
  }
}

// The rule's two times, Philippine Time, Monday to Friday: 9:00 AM (01:00 UTC) and 8:00 PM (12:00 UTC)
cron.schedule("0 9,20 * * 1-5", makeShadowSignal, { timezone: "Asia/Manila" });

export { makeShadowSignal };
