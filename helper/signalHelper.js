// Builds and records one market signal. Used by the /forecast endpoint (real
// signals) and the hourly shadow job (signals that are graded, never traded).
import { supabase } from "../config/supabase.js";
import {
  getExchangeConfig,
  fetchTechnicalData,
  getLatestHeadlines,
  askOllama,
  scoreSignal,
  scoreSignalV2,
  TIMEFRAME_MAP,
  MACRO_PAIRINGS,
} from "./marketHelper.js";
import { getMarketContext, describeContext, getSupportResistanceChecks } from "./marketContextHelper.js";
import { getCandleSummary, describeCandles, toFiveMinute } from "./candleContext.js";
import { loadCandles } from "./candleRecorder.js";
import { srLevels, SR_HOURS } from "./srLevels.js";

// The prompt includes the "last 6 hours of 5-minute candles" lines whenever recorded
// candles are available; each signal saves which prompt it used (prompt_version).

// Real signal requests in progress: the shadow job skips its turn while one runs,
// so it never makes a user wait on the single Ollama CPU slot.
let realRequestsInProgress = 0;
export const isSignalInProgress = () => realRequestsInProgress > 0;

// A rule pair stays open until the grader closes it at SL or TP (cron/gradeSignals.js)
const RULE_GRADER = "orchestrator-rule-1m";
const HOLD_DAYS = 15;

/** True while an earlier delayed-hedge pair (same shadow flag) hasn't hit SL or TP yet. */
const rulePairOpen = async (shadow) => {
  const { data, error } = await supabase.from("market_signals")
    .select("grade")
    .eq("shadow", shadow)
    .eq("inputs->rule->>passed", "true")
    .gte("created_at", new Date(Date.now() - HOLD_DAYS * 86400000).toISOString());
  if (error) throw new Error(error.message);
  return data.some((r) => !r.grade?.skipped && r.grade?.grader !== RULE_GRADER);
};

// Columns added by migration_shadow_signals.sql; dropped from the insert if it hasn't run
const SHADOW_COLUMNS = ["shadow", "tv_direction", "coin_direction", "score_v2"];

const insertSignal = async (record) => {
  let result = await supabase.from("market_signals").insert(record).select("id, created_at").single();
  if (result.error && /column/i.test(result.error.message)) {
    const legacy = { ...record };
    SHADOW_COLUMNS.forEach((c) => delete legacy[c]);
    result = await supabase.from("market_signals").insert(legacy).select("id, created_at").single();
  }
  return result;
};

export const generateSignal = async ({ symbol = "XAUUSD", timeframe = "1h", shadow = false } = {}) => {
  if (!shadow) realRequestsInProgress++;
  try {
    const targetSymbol = symbol.toUpperCase();
    const config = getExchangeConfig(targetSymbol);

    const microTfKey = timeframe.toLowerCase();
    const macroTfKey = MACRO_PAIRINGS[microTfKey] || "1d";
    const microTfData = TIMEFRAME_MAP[microTfKey] || TIMEFRAME_MAP["1h"];
    const macroTfData = TIMEFRAME_MAP[macroTfKey] || TIMEFRAME_MAP["1d"];

    const [microData, macroData, headlines, context] = await Promise.all([
      fetchTechnicalData(config, microTfData),
      fetchTechnicalData(config, macroTfData),
      getLatestHeadlines(),
      getMarketContext(targetSymbol),
    ]);
    const currentUtcTime = new Date().toUTCString();
    const candleSummary = await getCandleSummary(targetSymbol).catch(() => null);

    // =========================================================================
    // Delayed-hedge rule "S/R bounce, $40 stop" (tested as replay run sr-bounce-40 in
    // scripts/replayRules.js). Decides whether this trade runs the delayed hedge or the
    // normal hedge: delayed only at 9:00 AM or 8:00-8:15 PM PHT, with price in the bottom
    // 25% (buy) or top 25% (sell) of the 12-hour S/R range and the range under the $40
    // stop (replay run sr-bounce-40-9am-8pm). One pair at a time, and never with US
    // high-impact news within 4h (or no news calendar) or at rollover.
    // TradingView is recorded but not used: following it made delayed hedging lose.
    // =========================================================================
    const tvRaw = String(microData.decision || "").toLowerCase();
    const tvRating = tvRaw.includes("buy") ? "buy" : tvRaw.includes("sell") ? "sell" : null;
    const tvScore = Number(microData.recommend_all || 0);
    const currentPrice = Number(microData.price);

    // 1. Support/resistance from the recorded candles, the same way as the replay
    const nowMs = Date.now();
    const barStart = Math.floor(nowMs / 1000 / 300) * 300;   // the forming 5-minute bar doesn't count
    const recorded = await loadCandles(targetSymbol, nowMs - (SR_HOURS * 3600 + 600) * 1000, nowMs).catch(() => []);
    const levels = srLevels(toFiveMinute(recorded), barStart);
    const support = levels?.support ?? null, resistance = levels?.resistance ?? null;
    const range = levels ? Math.round(levels.range * 100) / 100 : null;
    const pos = levels && levels.range > 0 ? Math.max(0, Math.min(1, (currentPrice - levels.support) / levels.range)) : null;
    const posPct = pos == null ? null : Math.round(pos * 100);

    // 2. Sizing: 0.03 lot, $120 budget (12% of a $1,000 target) -> $40 stop
    const TARGET = 1000;
    const LOT = 0.03;
    const f = 0.12;
    const budget = TARGET * f;
    const slDist = Math.round((budget / (LOT * 100)) * 100) / 100;
    const rangeDollars = range == null ? null : Math.round(range * LOT * 100 * 100) / 100;

    // 3. The checks; all must pass for the delayed hedge
    const utcNow = new Date(nowMs);
    const utcHour = utcNow.getUTCHours();
    const session = utcHour === 1 ? "9am"                                        // 9:00-9:59 AM PHT
      : utcHour === 12 && utcNow.getUTCMinutes() < 15 ? "8pm" : null;           // 8:00-8:15 PM PHT
    // Only news and rollover may veto the delayed hedge (the v2 trend "traps" stay recorded,
    // the rule was tested without them). No news calendar counts as news: fail safe.
    const hedgeBlock = [
      ...(context.news ?? []).map((e) => `High-impact news: ${e.country} ${e.title} ${e.at.slice(11, 16)} UTC`),
      ...(context.news_feed_ok === false ? ["High-impact news: calendar unavailable"] : []),
      ...(context.rollover ? ["Rollover hours (thin market, wide spreads)"] : []),
    ];
    const pairOpen = await rulePairOpen(shadow).catch((e) => {
      console.warn(`[signal] Open-pair check failed: ${e.message}`);
      return true;   // unknown: don't stack a second delayed pair
    });
    const checks = {
      levels: !!levels,                                   // 12h of recorded candles
      window: !!session,                                  // the two tested times
      zone: pos != null && (pos <= 0.25 || pos >= 0.75),  // near support or resistance
      budget: rangeDollars != null && rangeDollars < budget,
      no_news: hedgeBlock.length === 0,
      no_open_pair: !pairOpen,
    };
    const passed = Object.values(checks).every(Boolean);
    const skipReason = !checks.levels ? "no 12-hour S/R levels (too few recorded candles)"
      : !checks.window ? "outside 9:00 AM / 8:00-8:15 PM PHT"
      : !checks.no_open_pair ? "the previous delayed pair is still open"
      : !checks.zone ? `price is mid-range (${posPct}% of the S/R range)`
      : !checks.budget ? `range $${range.toFixed(2)} is wider than the $${slDist.toFixed(0)} stop`
      : !checks.no_news ? hedgeBlock[0]
      : null;

    // Bounce side: buy in the lower half of the range, sell in the upper half
    const finalAction = (pos != null ? (pos <= 0.5 ? "buy" : "sell") : tvRating || "buy").toUpperCase();
    const isBuy = finalAction === "BUY";

    // 4. TP = the S/R range (at least $5), SL = $40
    const tpDist = range != null ? Math.max(range, 5.0) : slDist;
    const targetPrice = Math.round((currentPrice + (isBuy ? tpDist : -tpDist)) * 100) / 100;
    const stopPrice = Math.round((currentPrice + (isBuy ? -slDist : slDist)) * 100) / 100;

    // 5. Hedge trigger: $0.50 past the S/R level on the losing side, at least $2.50
    // away and capped at a $20 loss ($17.60 of price at 0.03 lot + $2.40 fees)
    const MAX_LOSS_DOLLARS = 20.0;
    const BROKER_COST = 2.40;
    const MAX_TRIG_DIST = (MAX_LOSS_DOLLARS - BROKER_COST) / (LOT * 100);
    const rawTriggerPx = levels ? (isBuy ? support - 0.5 : resistance + 0.5) : null;
    const triggerDist = rawTriggerPx == null ? MAX_TRIG_DIST : Math.max(2.50, Math.min(Math.abs(currentPrice - rawTriggerPx), MAX_TRIG_DIST));
    const triggerPrice = Math.round((currentPrice + (isBuy ? -triggerDist : triggerDist)) * 100) / 100;
    // Fraction of the SL distance; the pair stores it and the local server places the hedge there
    const trigFraction = Math.max(0.01, Math.min(0.99, Math.round((triggerDist / slDist) * 1000) / 1000));

    // 6. Background AI Consultation for News Impact & Qualitative Context
    let aiResponse = null;
    try {
      const ollamaPromise = askOllama(
        targetSymbol,
        microTfData.text,
        macroTfData.text,
        microData,
        macroData,
        headlines,
        currentUtcTime,
        describeContext(context),
        describeCandles(candleSummary)
      );
      // Fast fallback if Ollama VPS is offline or slow: don't delay the live trade
      aiResponse = await Promise.race([
        ollamaPromise,
        new Promise((_, reject) => setTimeout(() => reject(new Error("Ollama timeout (6s)")), 6000)),
      ]);
    } catch (err) {
      console.warn(`[signal] AI context consultation skipped: ${err.message}`);
    }
    const newsImpact = aiResponse?.news_impact || "neutral";

    const { score, breakdown } = scoreSignal(finalAction, microData, macroData, newsImpact);
    const v2 = scoreSignalV2(finalAction, microData, macroData, newsImpact, { ...context, slDistance: slDist, candleSummary });
    const supportResistance = await getSupportResistanceChecks(targetSymbol, currentPrice, finalAction.toLowerCase(), slDist)
      .catch(() => null);

    // 7. Reasoning
    const levelText = levels ? `Support $${support.toFixed(2)}, Resistance $${resistance.toFixed(2)} (range $${range.toFixed(2)}, last ${levels.hours}h)` : "no S/R levels";
    let reasoning = passed
      ? `[S/R bounce, $40 stop]: price is at ${posPct}% of the S/R range (${levelText}), so ${finalAction} the bounce with a delayed hedge. Stop $${slDist.toFixed(2)}, TP $${tpDist.toFixed(2)}, hedge trigger $${triggerPrice.toFixed(2)} ($20 max loss).`
      : `[S/R bounce, $40 stop]: normal hedge, ${skipReason}. ${levelText}.`;
    if (aiResponse?.reasoning && !aiResponse.reasoning.includes("unavailable")) {
      reasoning += ` AI Context: ${aiResponse.reasoning}`;
    }

    const finalConfidence = passed ? Math.max(score, 82) : Math.min(score, 55);

    // Record exactly what was suggested and why, at the moment it was generated.
    const signalRecord = {
      symbol: targetSymbol,
      direction: finalAction.toLowerCase(),
      reasoning,
      confidence: finalConfidence,
      entry_price: currentPrice,
      target_price: targetPrice,
      stop_price: stopPrice,
      source: "ai",
      model: "sr-bounce-40-9am-8pm",
      shadow,
      tv_direction: tvRating || String(microData.decision).toLowerCase(),
      coin_direction: Math.random() < 0.5 ? "buy" : "sell",
      score_v2: v2.score,
      inputs: {
        price: currentPrice,
        sma_200: microData.sma_200,
        atr: microData.atr,
        rsi: microData.raw_rsi,
        micro_timeframe: microTfData.text,
        micro_trend: microData.decision,
        macro_timeframe: macroTfData.text,
        macro_trend: macroData.decision,
        indicator_summary: microData.process,
        technical_basis: microData.basis,
        headlines,
        news_impact: newsImpact,
        macro_atr: macroData.atr,
        recommend_all: microData.recommend_all,
        score_breakdown: breakdown,
        score_v2_breakdown: v2.breakdown,
        volatility: context.volatility,
        news_ahead: context.news,
        hedge_block: hedgeBlock,
        score_v2_blocks: v2.blocks,
        support_resistance: supportResistance,
        prompt_version: "sr-bounce-40-live",
        candle_summary: candleSummary,
        picker: "sr-bounce",
        trigger: trigFraction,
        rule: {
          name: "sr-bounce",
          run: "sr-bounce-40-9am-8pm",
          session,
          passed,
          checks,
          skip_reason: skipReason,
          f,
          target: TARGET,
          lot: LOT,
          budget,
          sl_distance: slDist,
          tp_distance: tpDist,
          window_hours: levels?.hours ?? null,
          pump_dump: levels?.pump ?? null,
          support,
          resistance,
          range,
          range_dollars: rangeDollars,
          trigger_price: triggerPrice,
          trigger_fraction: trigFraction,
          max_loss_cap: MAX_LOSS_DOLLARS,
          proximity_pct: posPct,
          is_near_boundary: checks.zone,
          past_trend: tvRating || String(microData.decision).toLowerCase(),
          past_score: tvScore,
          past_counter_trend: false,
          in_budget: checks.budget,
        },
      },
    };

    const { data: savedSignal, error: signalError } = await insertSignal(signalRecord);
    if (signalError) {
      console.error("[market] Failed to record signal:", signalError.message);
    }

    return {
      signalRecord,
      response: {
        action: finalAction,
        target: targetPrice,
        stop: stopPrice,
        trigger: triggerPrice,
        support,
        resistance,
        proximity_pct: posPct,
        passed,
        skip_reason: skipReason,
        // The trade the rule was tested with, for the pairing screen to apply
        suggested_lot: LOT,
        suggested_sl_dollars: Math.round(slDist * LOT * 100 * 100) / 100,
        suggested_tp_dollars: Math.round(tpDist * LOT * 100 * 100) / 100,
        trigger_fraction: trigFraction,
        support1: microData.support1,
        support2: microData.support2,
        resistance1: microData.resistance1,
        resistance2: microData.resistance2,
        signal_id: savedSignal?.id ?? null,
        reasoning: signalRecord.reasoning,
        confidence: signalRecord.confidence,
        score_breakdown: breakdown,
        score_v2: v2.score,
        hedge_block: hedgeBlock,
        suggested_sl_distance: slDist,
        source: signalRecord.source,
        model: signalRecord.model,
        generated_at: savedSignal?.created_at ?? new Date().toISOString(),
      },
    };
  } finally {
    if (!shadow) realRequestsInProgress--;
  }
};
