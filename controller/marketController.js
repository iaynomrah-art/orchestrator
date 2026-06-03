import { BadRequestError } from "../errors/index.js";
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
    
    let finalAction = (aiResponse.verdict || "").trim().toUpperCase();
    
    // Fallback in case verdict is empty or invalid
    if (finalAction !== "BUY" && finalAction !== "SELL") {
      finalAction = microData.decision;
    }
        
    res.status(200).json({
      action: finalAction,
      target: aiResponse.target_price,
      stop: aiResponse.stop_loss,
      support1: microData.support1,
      support2: microData.support2,
      resistance1: microData.resistance1,
      resistance2: microData.resistance2
    });
  } catch (error) {
    next(error);
  }
};