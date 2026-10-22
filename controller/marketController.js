import { BadRequestError } from "../errors/index.js";
import { supabase } from "../config/supabase.js";
import {
  getExchangeConfig,
  fetchTechnicalData,
  TIMEFRAME_MAP,
} from "../helper/marketHelper.js";
import { generateSignal } from "../helper/signalHelper.js";
import { summarizeGrades } from "../helper/shadowResultsHelper.js";
import { getVolatility } from "../helper/marketContextHelper.js";
import { loadCandles } from "../helper/candleRecorder.js";

/**
 * Get market signal forecast for a symbol and timeframe
 * @route GET /api/v1/market/forecast
 */
export const getMarketForecast = async (req, res, next) => {
  try {
    const { response } = await generateSignal({
      symbol: req.query.symbol || "XAUUSD",
      timeframe: req.query.timeframe || "1h",
    });
    res.status(200).json(response);
  } catch (error) {
    next(error);
  }
};

/**
 * SL distance for a ~4-8h trade, for sizing lots (lots = SL $ / (distance x contract)).
 * From the MT5 volatility numbers when fresh, else 1.5x the 1h ATR (the AI's own stop).
 * No AI call, so it's instant.
 * @route GET /api/v1/market/volatility?symbol=XAUUSD
 */
export const getSizingVolatility = async (req, res, next) => {
  try {
    const targetSymbol = (req.query.symbol || "XAUUSD").toUpperCase();
    const vol = await getVolatility(targetSymbol);
    if (vol?.suggested_sl_distance) {
      return res.status(200).json({
        symbol: targetSymbol,
        source: "mt5",
        sl_distance: Number(vol.suggested_sl_distance),
        forecast_6h: Number(vol.forecast_6h),
        computed_at: vol.computed_at,
      });
    }
    const microData = await fetchTechnicalData(getExchangeConfig(targetSymbol), TIMEFRAME_MAP["1h"]);
    res.status(200).json({
      symbol: targetSymbol,
      source: "atr",
      sl_distance: Math.round(1.5 * microData.atr * 100) / 100,
      forecast_6h: null,
      computed_at: new Date().toISOString(),
    });
  } catch (error) {
    next(error);
  }
};

/**
 * Everything the Prediction Monitor page shows, in one call: whether shadow mode
 * runs, price recording and volatility freshness, the latest signals with their
 * outcomes, and the historical replay summary (data/replay_150.jsonl) if present.
 * @route GET /api/v1/market/shadow-status
 */
export const getShadowStatus = async (req, res, next) => {
  try {
    const now = new Date();
    const hourAgo = new Date(now.getTime() - 3600 * 1000).toISOString();
    const [vol, lastCandle, candlesHour, signals, totals, graded] = await Promise.all([
      supabase.from("market_volatility").select("computed_at, forecast_6h, ratio_now, source").eq("symbol", "XAUUSD").maybeSingle(),
      supabase.from("market_candles").select("minute, close, ticks").eq("symbol", "XAUUSD").order("minute", { ascending: false }).limit(1).maybeSingle(),
      supabase.from("market_candles").select("minute", { count: "exact", head: true }).eq("symbol", "XAUUSD").gte("minute", hourAgo),
      supabase.from("market_signals")
        .select("id, created_at, shadow, direction, tv_direction, coin_direction, confidence, score_v2, entry_price, graded_at, grade")
        .order("created_at", { ascending: false }).limit(25),
      supabase.from("market_signals").select("id", { count: "exact", head: true }).eq("shadow", true),
      supabase.from("market_signals").select("id", { count: "exact", head: true }).eq("shadow", true).not("graded_at", "is", null),
    ]);

    const outcome = (g, src) => g?.results?.[src]?.t10_tp1?.story ?? null;
    const nextRun = new Date(now);
    nextRun.setUTCMinutes(5, 0, 0);
    if (nextRun <= now) nextRun.setUTCHours(nextRun.getUTCHours() + 1);

    let replay = null;
    try {
      const fs = await import("fs");
      const path = new URL("../data/replay_150.jsonl", import.meta.url);
      if (fs.existsSync(path)) {
        const rows = fs.readFileSync(path, "utf8").trim().split(/\n/).filter(Boolean).map((l) => JSON.parse(l));
        const pick = (s) => ({ ai: s.overall.ai.a_rate, tv: s.overall.tv.a_rate, coin: s.overall.coin.a_rate, luck: s.luck_a_rate, resolved: s.overall.ai.resolved });
        replay = {
          signals: rows.length,
          agree_pct: Math.round((rows.filter((r) => r.direction === r.tv_direction).length / rows.length) * 100),
          t10: pick(summarizeGrades(rows, "t10_tp1")),
          t15: pick(summarizeGrades(rows, "t15_tp1")),
          from: rows[0]?.created_at, to: rows[rows.length - 1]?.created_at,
        };
      }
    } catch (error) {
      console.warn(`[market] Replay summary unavailable: ${error.message}`);
    }

    res.status(200).json({
      now: now.toISOString(),
      shadow_enabled: process.env.SHADOW_SIGNALS_ENABLED === "true",
      next_shadow_run: nextRun.toISOString(),
      volatility: vol.data ?? null,
      candles: { last: lastCandle.data ?? null, last_hour: candlesHour.count ?? 0 },
      counts: { shadow: totals.count ?? 0, graded: graded.count ?? 0 },
      signals: (signals.data || []).map((s) => ({
        id: s.id, created_at: s.created_at, shadow: s.shadow, entry_price: s.entry_price,
        ai: s.direction, tv: s.tv_direction, coin: s.coin_direction, score: s.confidence, score_v2: s.score_v2,
        graded_at: s.graded_at, skipped: s.grade?.skipped ?? null,
        outcome: { ai: outcome(s.grade, "ai"), tv: outcome(s.grade, "tv"), coin: outcome(s.grade, "coin") },
      })),
      replay,
    });
  } catch (error) {
    next(error);
  }
};

/**
 * Recorded gold candles for the monitor chart (grouped to `tf` minutes), plus the
 * shadow signals in that window with their entry, SL, TP and outcome.
 * @route GET /api/v1/market/candles?hours=12&tf=5
 */
export const getChartCandles = async (req, res, next) => {
  try {
    const hours = Math.min(Math.max(Number(req.query.hours) || 12, 1), 48);
    const tf = [1, 5, 15].includes(Number(req.query.tf)) ? Number(req.query.tf) : 5;
    const now = Date.now();
    const from = now - hours * 3600 * 1000;
    const [rows, signals] = await Promise.all([
      loadCandles("XAUUSD", from, now),
      supabase.from("market_signals")
        .select("id, created_at, direction, confidence, entry_price, stop_price, target_price, grade")
        .eq("shadow", true).gte("created_at", new Date(from).toISOString()).order("created_at"),
    ]);
    if (signals.error) throw new BadRequestError(signals.error.message);

    const bars = [];
    for (const c of rows) {
      const t = Math.floor(c.minute / (tf * 60000)) * tf * 60;   // bar start, epoch seconds
      const last = bars[bars.length - 1];
      if (last && last.time === t) {
        last.high = Math.max(last.high, c.high); last.low = Math.min(last.low, c.low); last.close = c.close;
      } else {
        bars.push({ time: t, open: c.open, high: c.high, low: c.low, close: c.close });
      }
    }
    res.status(200).json({
      symbol: "XAUUSD", tf, hours,
      candles: bars,
      signals: signals.data.map((s) => ({
        id: s.id, time: Math.floor(new Date(s.created_at).getTime() / 1000), direction: s.direction, score: s.confidence,
        entry: s.entry_price, stop: s.stop_price, target: s.target_price,
        outcome: s.grade?.results?.ai?.t10_tp1?.story ?? null,
      })),
    });
  } catch (error) {
    next(error);
  }
};

/**
 * How graded signals did, per score range: AI vs TradingView rating vs coin flip
 * @route GET /api/v1/market/shadow-results?days=30&setting=t10_tp1&score=v1&shadow=all
 */
export const getShadowResults = async (req, res, next) => {
  try {
    const days = Math.min(Math.max(Number(req.query.days) || 30, 1), 180);
    const setting = /^t(10|15)_(tp1|tpai)$/.test(req.query.setting) ? req.query.setting : "t10_tp1";
    const scoreVersion = req.query.score === "v2" ? "v2" : "v1";
    const since = new Date(Date.now() - days * 86400000).toISOString();

    const rows = [];
    for (let from = 0; ; from += 1000) {
      let query = supabase
        .from("market_signals")
        .select("created_at, shadow, direction, tv_direction, coin_direction, confidence, score_v2, grade, sr:inputs->support_resistance")
        .not("graded_at", "is", null)
        .gte("created_at", since)
        .order("created_at")
        .range(from, from + 999);
      if (req.query.shadow === "only") query = query.eq("shadow", true);
      const { data, error } = await query;
      if (error) throw new BadRequestError(`Could not read graded signals: ${error.message}`);
      rows.push(...data);
      if (data.length < 1000) break;
    }

    res.status(200).json({ days, ...summarizeGrades(rows, setting, scoreVersion) });
  } catch (error) {
    next(error);
  }
};

/**
 * Get just the current price for a symbol — cheap, no Ollama call, safe to
 * poll frequently for a live-feeling price display (unlike /forecast, which
 * can take up to 60s because of the LLM call).
 * @route GET /api/v1/market/price
 */
export const getCurrentPrice = async (req, res, next) => {
  try {
    const symbol = req.query.symbol || "XAUUSD";
    const targetSymbol = symbol.toUpperCase();
    const config = getExchangeConfig(targetSymbol);
    const microTfData = TIMEFRAME_MAP["5m"] || TIMEFRAME_MAP["1h"];

    const data = await fetchTechnicalData(config, microTfData);

    res.status(200).json({
      symbol: targetSymbol,
      price: data.price,
      timestamp: Date.now(),
    });
  } catch (error) {
    next(error);
  }
};

/**
 * Get market support and resistance levels for a symbol and timeframe
 * @route GET /api/v1/market/levels
 */
export const getSupportResistance = async (req, res, next) => {
  try {
    const symbol = req.query.symbol || "XAUUSD";
    const timeframe = req.query.timeframe || "1h";

    const targetSymbol = symbol.toUpperCase();
    const config = getExchangeConfig(targetSymbol);
    
    const microTfKey = timeframe.toLowerCase();
    const microTfData = TIMEFRAME_MAP[microTfKey] || TIMEFRAME_MAP["1h"];

    const microData = await fetchTechnicalData(config, microTfData);
        
    res.status(200).json({
      support1: microData.support1,
      support2: microData.support2,
      resistance1: microData.resistance1,
      resistance2: microData.resistance2
    });

  } catch (error) {
    next(error);
  }
};