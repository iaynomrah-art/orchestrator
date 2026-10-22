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

// Real signal requests in progress: the shadow job skips its turn while one runs,
// so it never makes a user wait on the single Ollama CPU slot.
let realRequestsInProgress = 0;
export const isSignalInProgress = () => realRequestsInProgress > 0;

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

    const aiResponse = await askOllama(
      targetSymbol,
      microTfData.text,
      macroTfData.text,
      microData,
      macroData,
      headlines,
      currentUtcTime,
      describeContext(context)
    );

    // askOllama always returns BUY or SELL (falling back to the technicals itself)
    const finalAction = aiResponse.verdict;
    const { score, breakdown } = scoreSignal(finalAction, microData, macroData, aiResponse.news_impact);
    const slDistance = Math.abs(Number(microData.price) - Number(aiResponse.stop_loss));
    const v2 = scoreSignalV2(finalAction, microData, macroData, aiResponse.news_impact, { ...context, slDistance });
    // Tracked only (not in the score): graded later to see if these levels avoid the hedge trigger
    const supportResistance = await getSupportResistanceChecks(targetSymbol, Number(microData.price), finalAction.toLowerCase(), slDistance)
      .catch(() => null);

    // Record exactly what was suggested and why, at the moment it was generated.
    // Pairing links a trade to this record by id, so the explanation shown later
    // is always the model's own output, never text typed in afterwards.
    const signalRecord = {
      symbol: targetSymbol,
      direction: finalAction.toLowerCase(),
      reasoning: aiResponse.reasoning || null,
      confidence: score,
      entry_price: microData.price,
      target_price: aiResponse.target_price ?? null,
      stop_price: aiResponse.stop_loss ?? null,
      source: aiResponse.source,
      model: aiResponse.model,
      shadow,
      // The two baselines graded against the AI: TradingView's rating alone, and luck
      tv_direction: String(microData.decision).toLowerCase(),
      coin_direction: Math.random() < 0.5 ? "buy" : "sell",
      score_v2: v2.score,
      inputs: {
        price: microData.price,
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
        news_impact: aiResponse.news_impact,
        macro_atr: macroData.atr,
        recommend_all: microData.recommend_all,
        score_breakdown: breakdown,
        score_v2_breakdown: v2.breakdown,
        volatility: context.volatility,
        news_ahead: context.news,
        hedge_block: v2.blocks,
        support_resistance: supportResistance,
      },
    };

    const { data: savedSignal, error: signalError } = await insertSignal(signalRecord);
    if (signalError) {
      // The suggestion still works; it just can't be linked to a trade for its explanation
      console.error("[market] Failed to record signal:", signalError.message);
    }

    return {
      signalRecord,
      response: {
        action: finalAction,
        target: aiResponse.target_price,
        stop: aiResponse.stop_loss,
        support1: microData.support1,
        support2: microData.support2,
        resistance1: microData.resistance1,
        resistance2: microData.resistance2,
        signal_id: savedSignal?.id ?? null,
        reasoning: signalRecord.reasoning,
        confidence: signalRecord.confidence,
        score_breakdown: breakdown,
        score_v2: v2.score,
        hedge_block: v2.blocks,
        // Lot for a ~4-8h trade = SL $ / (this distance x contract size), when MT5 numbers are fresh
        suggested_sl_distance: context.volatility?.suggested_sl_distance ?? null,
        source: signalRecord.source,
        model: signalRecord.model,
        generated_at: savedSignal?.created_at ?? new Date().toISOString(),
      },
    };
  } finally {
    if (!shadow) realRequestsInProgress--;
  }
};
