import { BadRequestError } from "../errors/index.js";
import { supabase } from "../config/supabase.js";
import { 
  getExchangeConfig, 
  fetchTechnicalData, 
  getLatestHeadlines, 
  askOllama, 
  TIMEFRAME_MAP, 
  MACRO_PAIRINGS 
} from "../helper/marketHelper.js";

/**
 * Get market signal forecast for a symbol and timeframe
 * @route GET /api/v1/market/forecast
 */
export const getMarketForecast = async (req, res, next) => {
  try {
    const symbol = req.query.symbol || "XAUUSD";
    const timeframe = req.query.timeframe || "1h";

    const targetSymbol = symbol.toUpperCase();
    const config = getExchangeConfig(targetSymbol);
    
    const microTfKey = timeframe.toLowerCase();
    const macroTfKey = MACRO_PAIRINGS[microTfKey] || "1d"; 
    
    const microTfData = TIMEFRAME_MAP[microTfKey] || TIMEFRAME_MAP["1h"];
    const macroTfData = TIMEFRAME_MAP[macroTfKey] || TIMEFRAME_MAP["1d"];

    const microData = await fetchTechnicalData(config, microTfData);
    const macroData = await fetchTechnicalData(config, macroTfData);

    const headlines = await getLatestHeadlines();
    const currentUtcTime = new Date().toUTCString();

    const aiResponse = await askOllama(
      targetSymbol, 
      microTfData.text, 
      macroTfData.text, 
      microData, 
      macroData, 
      headlines,
      currentUtcTime
    );
    
    // askOllama always returns BUY or SELL (falling back to the technicals itself)
    const finalAction = aiResponse.verdict;

    // Record exactly what was suggested and why, at the moment it was generated.
    // Pairing links a trade to this record by id, so the explanation shown later
    // is always the model's own output, never text typed in afterwards.
    const signalRecord = {
      symbol: targetSymbol,
      direction: finalAction.toLowerCase(),
      reasoning: aiResponse.reasoning || null,
      confidence: aiResponse.confidence_score ?? null,
      entry_price: microData.price,
      target_price: aiResponse.target_price ?? null,
      stop_price: aiResponse.stop_loss ?? null,
      source: aiResponse.source,
      model: aiResponse.model,
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
      },
    };

    let signalId = null;
    const { data: savedSignal, error: signalError } = await supabase
      .from("market_signals")
      .insert(signalRecord)
      .select("id, created_at")
      .single();
    if (signalError) {
      // The suggestion still works; it just can't be linked to a trade for its explanation
      console.error("[market] Failed to record signal:", signalError.message);
    } else {
      signalId = savedSignal.id;
    }

    res.status(200).json({
      action: finalAction,
      target: aiResponse.target_price,
      stop: aiResponse.stop_loss,
      support1: microData.support1,
      support2: microData.support2,
      resistance1: microData.resistance1,
      resistance2: microData.resistance2,
      signal_id: signalId,
      reasoning: signalRecord.reasoning,
      confidence: signalRecord.confidence,
      source: signalRecord.source,
      model: signalRecord.model,
      generated_at: savedSignal?.created_at ?? new Date().toISOString(),
    });


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