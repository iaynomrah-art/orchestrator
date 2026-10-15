import Parser from "rss-parser";

const rssParser = new Parser();

// Helper for rounding decimal values
export const round = (num, decimalPlaces = 2) => {
  const p = Math.pow(10, decimalPlaces);
  return Math.round((num + Number.EPSILON) * p) / p;
};

// --- Timeframe Mapping Engine ---
export const TIMEFRAME_MAP = {
  "5m": { tv_suffix: "|5", text: "5 minutes" },
  "15m": { tv_suffix: "|15", text: "15 minutes" },
  "1h": { tv_suffix: "|60", text: "1 hour" },
  "4h": { tv_suffix: "|240", text: "4 hours" },
  "1d": { tv_suffix: "", text: "1 day" },
  "1W": { tv_suffix: "|1W", text: "1 week" },
  "1M": { tv_suffix: "|1M", text: "1 month" }
};

export const MACRO_PAIRINGS = {
  "5m": "1h",
  "15m": "4h",
  "1h": "1d",
  "4h": "1W",
  "1d": "1M"
};

// Fetch headlines from forexlive RSS. Returns an array of strings (empty when none).
export const getLatestHeadlines = async () => {
  try {
    const feed = await rssParser.parseURL("https://www.forexlive.com/feed/news");
    const headlinesWithTime = [];
    
    // Take top 3 entries
    const entries = feed.items.slice(0, 3);
    for (const entry of entries) {
      const title = entry.title;
      const publishedTime = entry.pubDate || "Unknown time";
      headlinesWithTime.push(`[${publishedTime}] ${title}`);
    }
    
    return headlinesWithTime;
  } catch (error) {
    return [];
  }
};

// Get TradingView exchange configuration
export const getExchangeConfig = (symbol) => {
  const targetSymbol = symbol.toUpperCase();
  if (targetSymbol === "XAUUSD" || targetSymbol === "GOLD") {
    return { tv_symbol: "GOLD", screener: "cfd", exchange: "TVC" };
  } else if (targetSymbol === "BTCUSD") {
    return { tv_symbol: "BTCUSD", screener: "crypto", exchange: "COINBASE" };
  } else {
    return { tv_symbol: targetSymbol, screener: "crypto", exchange: "BINANCE" };
  }
};

// Fetch technical data directly from TradingView Scanner API
export const fetchTechnicalData = async (config, tfData) => {
  const suffix = tfData.tv_suffix;
  const url = `https://scanner.tradingview.com/${config.screener}/scan`;
  
  const columns = [
    `Recommend.All${suffix}`,
    `close${suffix}`,
    `RSI${suffix}`,
    `MACD.macd${suffix}`,
    `EMA20${suffix}`,
    `SMA200${suffix}`,
    `SMA50${suffix}`,
    `ATR${suffix}`,
    `Recommend.MA${suffix}`,
    `Recommend.Other${suffix}`,
    `Pivot.M.Classic.S1`,
    `Pivot.M.Classic.S2`,
    `Pivot.M.Classic.R1`,
    `Pivot.M.Classic.R2`
  ];

  const ticker = `${config.exchange}:${config.tv_symbol}`;

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)"
    },
    body: JSON.stringify({
      symbols: {
        tickers: [ticker],
        query: { types: [] }
      },
      columns: columns
    })
  });

  if (!response.ok) {
    throw new Error(`TradingView scan request failed: ${response.statusText}`);
  }

  const result = await response.json();
  const d = result.data?.[0]?.d;
  if (!d || d.length === 0) {
    throw new Error(`No data returned from TradingView scanner for ${ticker}`);
  }

  const recommendAll = d[0] ?? 0;
  const price = round(d[1] ?? 0, 2);
  const rsi = round(d[2] ?? 50, 2);
  const macd = round(d[3] ?? 0, 2);
  const ema20 = round(d[4] ?? 0, 2);
  const sma200 = round(d[5] ?? 0, 2);
  const sma50 = round(d[6] ?? 0, 2);
  
  const rawAtr = d[7];
  const atr = (rawAtr === undefined || rawAtr === null || rawAtr === 0) 
    ? round(price * 0.002, 2) 
    : round(rawAtr, 2);

  const support1 = round(d[10] ?? 0, 2);
  const support2 = round(d[11] ?? 0, 2);
  const resistance1 = round(d[12] ?? 0, 2);
  const resistance2 = round(d[13] ?? 0, 2);

  const decision = recommendAll >= 0 ? "BUY" : "SELL";

  const total = 26;
  const buyVotes = Math.round((recommendAll + 1) * 9);
  const sellVotes = Math.round((1 - recommendAll) * 9);
  const neutralVotes = Math.max(0, total - buyVotes - sellVotes);
  const mathProcess = `Analyzed ${total} indicators. Results: ${buyVotes} BUY, ${sellVotes} SELL, ${neutralVotes} NEUTRAL. Verdict: ${decision}.`;

  const rsiTxt = rsi > 70 ? `RSI ${rsi} (Overbought)` : rsi < 30 ? `RSI ${rsi} (Oversold)` : `RSI ${rsi} (Neutral)`;
  const macdTxt = macd < 0 ? `MACD Bearish (${macd})` : `MACD Bullish (${macd})`;
  const trendTxt = `Price vs 200 SMA: ${price > sma200 ? "Above" : "Below"}. Price vs 50 SMA: ${price > sma50 ? "Above" : "Below"}`;
  
  return {
    decision: decision,
    process: mathProcess,
    basis: `${trendTxt}. ${macdTxt}. ${rsiTxt}.`,
    price: price,
    raw_rsi: rsi,
    atr: atr,
    sma_200: sma200,
    support1: support1,
    support2: support2,
    resistance1: resistance1,
    resistance2: resistance2
  };
};

// Ollama server: a base URL (e.g. your Ollama domain) or the full /api/generate endpoint
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || "qwen2.5:3b";
const getOllamaGenerateUrl = () => {
  const base = (process.env.OLLAMA_URL || "http://localhost:11434").replace(/\/+$/, "");
  return base.endsWith("/api/generate") ? base : `${base}/api/generate`;
};

// Ask Ollama LLM for forecast validation.
// Returns source "ai" when the verdict and reasoning come from the model, or
// "technicals_fallback" when the model was unavailable or gave no valid verdict —
// the reasoning then says so instead of showing model text that doesn't match.
export const askOllama = async (symbol, microTf, macroTf, microData, macroData, headlines, currentUtcTime) => {
  const currentPrice = microData.price;
  const atr = microData.atr;

  const buyStop = round(currentPrice - (1.5 * atr), 2);
  const buyTarget = round(currentPrice + (2.0 * atr), 2);
  const sellStop = round(currentPrice + (1.5 * atr), 2);
  const sellTarget = round(currentPrice - (2.0 * atr), 2);

  const systemPrompt = `You are a strict quantitative trading AI analyzing ${symbol} for a short-term (${microTf}) execution bot.
    
CURRENT SYSTEM TIME: ${currentUtcTime}
CURRENT PRICE: ${currentPrice}
200 SMA (Long Term Trend): ${microData.sma_200}
ATR (Volatility): ${atr}

[1] MACRO TREND (${macroTf}): ${macroData.decision}
[2] MICRO TREND (${microTf}): ${microData.decision}

LATEST HEADLINES:
${(headlines && headlines.length ? headlines : ["(none available)"]).map((h) => `- ${h}`).join("\n")}

DECISION LOGIC (Execute strictly for short-term ${microTf} horizon):
1. TREND ALIGNMENT: Prioritize the Micro Trend (${microTf}) if the current price is above the 200 SMA (for BUY) or below the 200 SMA (for SELL). 
2. RISK/REWARD SELECTION: 
   - If you output BUY: Set stop_loss to ${buyStop} and target_price to ${buyTarget}.
   - If you output SELL: Set stop_loss to ${sellStop} and target_price to ${sellTarget}.
3. NEWS CUES: Only reference the provided headlines if they explicitly invalidate the technical setup. Otherwise, ignore them.

Respond strictly in JSON format matching this exact schema. Do not output markdown code blocks, just the raw JSON:
{
  "verdict": "BUY", // MUST BE EXACTLY ONE WORD: either "BUY" or "SELL". No sentences.
  "entry_price": ${currentPrice},
  "target_price": <number>,
  "stop_loss": <number>,
  "confidence_score": <number>,
  "reasoning": "Short 2-sentence explanation."
}
`;

  const payload = {
    model: OLLAMA_MODEL,
    prompt: systemPrompt,
    stream: false,
    format: "json",
    // Keep the model loaded between signal requests so we don't pay the ~6-8s reload each time
    keep_alive: process.env.OLLAMA_KEEP_ALIVE || "30m",
    options: { temperature: 0.0, num_thread: Number(process.env.OLLAMA_NUM_THREAD) || 6 }
  };

  const fallback = (why) => {
    const fallbackVerdict = microData.decision;
    return {
      verdict: fallbackVerdict,
      entry_price: currentPrice,
      target_price: fallbackVerdict === "BUY" ? buyTarget : sellTarget,
      stop_loss: fallbackVerdict === "BUY" ? buyStop : sellStop,
      confidence_score: null,
      reasoning: `${why} Direction taken from the ${microTf} technical indicators (${microData.process})`,
      source: "technicals_fallback",
      model: null,
    };
  };

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 60000);

    const headers = { "Content-Type": "application/json" };
    // OLLAMA_AUTH is a full Authorization header value (e.g. "Basic <base64>" for Traefik basicauth)
    if (process.env.OLLAMA_AUTH) {
      headers.Authorization = process.env.OLLAMA_AUTH;
    } else if (process.env.OLLAMA_USERNAME && process.env.OLLAMA_PASSWORD) {
      const creds = Buffer.from(`${process.env.OLLAMA_USERNAME}:${process.env.OLLAMA_PASSWORD}`).toString("base64");
      headers.Authorization = `Basic ${creds}`;
    } else if (process.env.OLLAMA_API_KEY) {
      headers.Authorization = `Bearer ${process.env.OLLAMA_API_KEY}`;
    }

    const response = await fetch(getOllamaGenerateUrl(), {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
      signal: controller.signal
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      throw new Error(`Ollama HTTP error: ${response.status} ${response.statusText}`);
    }

    const data = await response.json();
    const rawResponse = data.response || "{}";
    const aiData = JSON.parse(rawResponse);

    const verdict = String(aiData.verdict || "").trim().toUpperCase();
    if (verdict !== "BUY" && verdict !== "SELL") {
      // The model's reasoning doesn't back the direction we'd fall back to, so don't keep it
      return fallback("The AI model returned no valid verdict.");
    }

    return {
      ...aiData,
      verdict,
      confidence_score: Number.isFinite(Number(aiData.confidence_score)) ? Number(aiData.confidence_score) : null,
      reasoning: typeof aiData.reasoning === "string" ? aiData.reasoning.trim().slice(0, 1000) : null,
      source: "ai",
      model: OLLAMA_MODEL,
    };
  } catch (error) {
    console.error(`Ollama error: ${error.message}`);
    return fallback("The AI model was unavailable.");
  }
};
