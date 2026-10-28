import fs from "fs";
import { fileURLToPath } from "url";
import path from "path";
import { loadCsv, serverToUtcMs, lowerBound } from "../scripts/replayData.js";
import { loadCandles } from "./candleRecorder.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const CSV_PATH = path.join(__dirname, "../data/XAUUSD.r_M5.csv");

let cachedM5 = null;

const getM5Data = () => {
  if (cachedM5) return cachedM5;
  if (!fs.existsSync(CSV_PATH)) return null;
  try {
    const raw = loadCsv(CSV_PATH);
    const utcTimes = raw.time.map((t) => Math.floor(serverToUtcMs(t) / 1000));
    cachedM5 = {
      raw,
      utcTimes,
      minUtc: utcTimes[0],
      maxUtc: utcTimes[utcTimes.length - 1],
    };
    return cachedM5;
  } catch (err) {
    console.warn(`[tradeChartHelper] Failed to load M5 CSV: ${err.message}`);
    return null;
  }
};

/**
 * Returns 5-minute candles surrounding a given trade entry timestamp.
 * Pulls from the 8-month historical CSV if available, or falls back to live market_candles.
 */
export const getTradeCandles = async (timeInput, { beforeHours = 4, afterHours = 10 } = {}) => {
  let targetSec = Number(timeInput);
  if (isNaN(targetSec) || targetSec < 1e9) {
    const d = new Date(timeInput);
    if (isNaN(d.getTime())) throw new Error(`Invalid time input: ${timeInput}`);
    targetSec = Math.floor(d.getTime() / 1000);
  } else if (targetSec > 1e11) {
    targetSec = Math.floor(targetSec / 1000);
  }

  const fromSec = targetSec - beforeHours * 3600;
  const toSec = targetSec + afterHours * 3600;

  // 1. Try historical M5 CSV
  const m5 = getM5Data();
  if (m5 && fromSec >= m5.minUtc - 3600 && toSec <= m5.maxUtc + 86400) {
    const i0 = lowerBound(m5.utcTimes, fromSec);
    const i1 = lowerBound(m5.utcTimes, toSec);
    const candles = [];
    for (let i = i0; i < i1 && i < m5.utcTimes.length; i++) {
      candles.push({
        time: m5.utcTimes[i],
        open: m5.raw.open[i],
        high: m5.raw.high[i],
        low: m5.raw.low[i],
        close: m5.raw.close[i],
      });
    }
    if (candles.length > 0) {
      return { symbol: "XAUUSD", trade_time: targetSec, source: "csv", candles };
    }
  }

  // 2. Fall back to live recorded market_candles
  const fromMs = fromSec * 1000;
  const toMs = toSec * 1000;
  const rows = await loadCandles("XAUUSD", fromMs, toMs);

  const bars = [];
  const tfSec = 5 * 60;
  for (const c of rows) {
    const t = Math.floor(c.minute / (tfSec * 1000)) * tfSec;
    const last = bars[bars.length - 1];
    if (last && last.time === t) {
      last.high = Math.max(last.high, c.high);
      last.low = Math.min(last.low, c.low);
      last.close = c.close;
    } else {
      bars.push({ time: t, open: c.open, high: c.high, low: c.low, close: c.close });
    }
  }

  return { symbol: "XAUUSD", trade_time: targetSec, source: "market_candles", candles: bars };
};
