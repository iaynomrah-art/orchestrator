import { supabase } from "../config/supabase.js";
import { getExchangeConfig, fetchTechnicalData, TIMEFRAME_MAP } from "../helper/marketHelper.js";
import { recordPrice } from "../helper/candleRecorder.js";

let lastPrice = null;
let isRunning = false;
let lastErrorLogAt = 0;

// Shorter than realtime-js's 10s default: ticks run every 2s, so a hung broadcast
// shouldn't block the loop for long. A stale price isn't worth waiting for.
const BROADCAST_TIMEOUT_MS = 4000;

// Created once and reused. The channel is never subscribed: we only publish, so
// messages go through Supabase Realtime's HTTP broadcast endpoint via httpSend().
// (Calling send() on an unsubscribed channel is the deprecated implicit fallback.)
const channel = supabase.channel("market-data");

function logError(message) {
  // At most one log per minute so a Supabase outage doesn't flood the console.
  const now = Date.now();
  if (now - lastErrorLogAt > 60000) {
    lastErrorLogAt = now;
    console.error(`[priceStreamer] ${message}`);
  }
}

async function streamPrice() {
  // Skip this tick if the previous one is still running (slow price fetch).
  if (isRunning) return;
  isRunning = true;
  try {
    const symbol = "XAUUSD";
    const targetSymbol = symbol.toUpperCase();
    const config = getExchangeConfig(targetSymbol);
    const microTfData = TIMEFRAME_MAP["5m"] || TIMEFRAME_MAP["1h"];

    const data = await fetchTechnicalData(config, microTfData);
    const currentPrice = data.price;
    // Every fetched price feeds the 1-minute candles used to grade shadow signals
    recordPrice(targetSymbol, currentPrice);

    if (currentPrice && currentPrice !== lastPrice) {
      const result = await channel.httpSend("price-update", {
        symbol: targetSymbol,
        price: currentPrice,
        timestamp: Date.now()
      }, { timeout: BROADCAST_TIMEOUT_MS });

      if (result.success) {
        lastPrice = currentPrice;
      } else {
        // lastPrice is not updated, so the next tick retries.
        logError(`Broadcast failed (${result.status}): ${result.error}`);
      }
    }
  } catch (error) {
    logError(`Tick failed: ${error.message}`);
  } finally {
    isRunning = false;
  }
}

// Start the loop for scraping and broadcasting every 2 seconds
setInterval(streamPrice, 2000);
