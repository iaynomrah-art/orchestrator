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

  const request = () => fetch(url, {
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
    }),
    signal: AbortSignal.timeout(15000)
  });

  // A dropped connection ("fetch failed", timeout) is retried twice; an HTTP error is not
  let response;
  for (let attempt = 1; ; attempt++) {
    try {
      response = await request();
      break;
    } catch (error) {
      if (attempt >= 3) throw new Error(`TradingView scan unreachable (${error.cause?.code || error.message})`);
      await new Promise((r) => setTimeout(r, 1500 * attempt));
    }
  }

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
    recommend_all: recommendAll,
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
export const askOllama = async (symbol, microTf, macroTf, microData, macroData, headlines, currentUtcTime, contextLines = [], candleLines = []) => {
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
${microData.support1 && microData.resistance1 ? `PIVOT LEVELS: Support (S1) = ${microData.support1} | Resistance (R1) = ${microData.resistance1}\n` : ""}
[1] MACRO TREND (${macroTf}): ${macroData.decision}
[2] MICRO TREND (${microTf}): ${microData.decision}

LATEST HEADLINES:
${(headlines && headlines.length ? headlines : ["(none available)"]).map((h) => `- ${h}`).join("\n")}
${contextLines.length ? `\nMARKET CONDITIONS:\n${contextLines.map((l) => `- ${l}`).join("\n")}\n` : ""}${candleLines.length ? `\nLAST 6 HOURS (5-minute candles & S/R Structure):\n${candleLines.map((l) => `- ${l}`).join("\n")}\n` : ""}
DECISION LOGIC (Follow these rules strictly):
1. TREND & MARKET STRUCTURE (HIGHEST PRIORITY):
- If Market Structure is DOWNTREND or shows Bearish Breakdown Momentum: Output "SELL". Never buy into a breakdown or falling knife.
- If Market Structure is UPTREND or shows Bullish Breakout Momentum: Output "BUY". Never short into an uptrend breakout.

2. RANGE-BOUND BOUNDARY TRADING (Only when Market Structure is RANGING / MIXED):
- If price is at Support Floor WITH buyer rejection wick: Output "BUY" (trading the confirmed bounce).
- If price is at Resistance Ceiling WITH seller rejection wick: Output "SELL" (trading the confirmed rejection).
- If price is in Middle of Range: Align with the Micro Trend (${microTf}) and 200 SMA.

3. NEWS IMPACT:
- Verify headlines do not contradict your directional verdict.

4. REASONING REQUIREMENTS (Simple & Detailed):
- Sentence 1 (Setup & Level): State the current market structure and specific price level (e.g. bounce off Support floor at $X, breakout above 200 SMA at $Y, or rejection at Resistance ceiling at $Z).
- Sentence 2 (Momentum & Objective): State momentum confirmation and target level (e.g. targeting resistance ceiling with defined risk).
- DO NOT use generic meta-language like "the 1 hour micro trend indicates", "the latest headlines do not provide enough information to override", or "takes precedence". Speak with direct institutional clarity.
- Keep the reasoning 100% technical (price action, support/resistance, 200 SMA). NEVER mention news, headlines, or economic data in the reasoning.

Respond strictly in JSON format matching this exact schema. Do not output markdown code blocks, just the raw JSON:
{
  "verdict": "BUY", // MUST BE EXACTLY ONE WORD: either "BUY" or "SELL". No sentences.
  "news_impact": "neutral", // MUST BE EXACTLY ONE WORD: "supports", "against" or "neutral".
  "reasoning": "Price confirmed support above $4,170 with a bullish rejection wick. Momentum remains positive above the 200 SMA, targeting continuation toward the $4,195 resistance ceiling."
}
`;

  const payload = {
    model: OLLAMA_MODEL,
    prompt: systemPrompt,
    stream: false,
    format: "json",
    // Keep the model loaded between signal requests so we don't pay the ~6-8s reload each time
    keep_alive: process.env.OLLAMA_KEEP_ALIVE || "30m",
    // 4 of the VPS's 6 cores, so a signal doesn't stall the other apps on it
    options: { temperature: 0.0, num_thread: Number(process.env.OLLAMA_NUM_THREAD) || 4 }
  };

  const fallback = (why) => {
    const fallbackVerdict = microData.decision;
    return {
      verdict: fallbackVerdict,
      entry_price: currentPrice,
      target_price: fallbackVerdict === "BUY" ? buyTarget : sellTarget,
      stop_loss: fallbackVerdict === "BUY" ? buyStop : sellStop,
      news_impact: "neutral",
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

    // The model only picks the direction. Levels always come from the ATR math above,
    // since the model sometimes copies the other direction's numbers back.
    return {
      ...aiData,
      verdict,
      entry_price: currentPrice,
      target_price: verdict === "BUY" ? buyTarget : sellTarget,
      stop_loss: verdict === "BUY" ? buyStop : sellStop,
      news_impact: ["supports", "against"].includes(String(aiData.news_impact).trim().toLowerCase())
        ? String(aiData.news_impact).trim().toLowerCase()
        : "neutral",
      reasoning: typeof aiData.reasoning === "string" ? aiData.reasoning.trim().slice(0, 1000) : null,
      source: "ai",
      model: OLLAMA_MODEL,
    };
  } catch (error) {
    console.error(`Ollama error: ${error.message}`);
    return fallback("The AI model was unavailable.");
  }
};

// Points-based signal score (0-100), stored as the signal's confidence.
// Each check looks at the inputs from the chosen direction's side; the
// weights are a starting point to tune once real trade results exist.
export const scoreSignal = (direction, microData, macroData, newsImpact) => {
  const isBuy = direction === "BUY";
  const sameSide = (decision) => decision === direction;
  // TradingView's Recommend.All: above 0.1 is a buy rating, below -0.1 a sell rating
  const vote = isBuy ? microData.recommend_all : -microData.recommend_all;
  // A 1h ATR above ~35% of the daily ATR means unusually wide hourly candles
  const atrRatio = macroData.atr > 0 ? microData.atr / macroData.atr : null;

  const checks = [
    { check: "Both trends agree with the direction", points: 25, passed: sameSide(microData.decision) && sameSide(macroData.decision) },
    { check: "Price on the correct side of the 200 SMA", points: 15, passed: isBuy ? microData.price > microData.sma_200 : microData.price < microData.sma_200 },
    { check: "Indicator vote clearly favors the direction", points: 20, passed: vote > 0.1 },
    { check: "RSI not stretched against the trade", points: 10, passed: isBuy ? microData.raw_rsi < 70 : microData.raw_rsi > 30 },
    { check: "Volatility (ATR) normal", points: 10, passed: atrRatio !== null && atrRatio <= 0.35 },
    { check: "News supports the direction", points: 20, passed: newsImpact === "supports" },
    { check: "News goes against the direction", points: -20, passed: newsImpact === "against" },
  ];

  const total = checks.reduce((sum, c) => sum + (c.passed ? c.points : 0), 0);
  return { score: Math.max(0, Math.min(100, total)), breakdown: checks };
};

// The same score with the MT5 volatility checks in place of "ATR normal". Saved
// next to the original so graded signals show whether the new checks help.
// Blocks (news, rollover) don't change points: they keep the delayed hedge off.
export const scoreSignalV2 = (direction, microData, macroData, newsImpact, ctx = {}) => {
  const base = scoreSignal(direction, microData, macroData, newsImpact);
  const isAtrCheck = (c) => c.check.startsWith("Volatility (ATR)");
  const checks = base.breakdown.filter((c) => !isAtrCheck(c));
  const vol = ctx.volatility;
  const ratio = vol?.ratio_now == null ? null : Number(vol.ratio_now);
  if (ratio !== null) {
    checks.push({ check: "Moving normally for this hour", points: 10, passed: ratio >= 0.5 && ratio <= 1.8 });
    checks.push({ check: "Much wilder than normal for this hour", points: -10, passed: ratio > 1.8 });
    checks.push({ check: "Barely moving for this hour", points: -10, passed: ratio < 0.5 });
    // Mean time to SL/TP grows with (distance / hourly move)^2; above ~3.5x it rarely finishes in 8h
    const forecast = Number(vol.forecast_6h);
    if (forecast > 0 && ctx.slDistance > 0) {
      checks.push({ check: "Stop too far to finish within 8h", points: -10, passed: ctx.slDistance / forecast > 3.5 });
    }
  } else {
    checks.push(base.breakdown.find(isAtrCheck));   // no fresh MT5 numbers: keep the ATR check
  }

  const blocks = [];
  if (ctx.news?.length) blocks.push(`High-impact news: ${ctx.news.map((e) => `${e.country} ${e.title} ${e.at.slice(11, 16)} UTC`).join(", ")}`);
  if (ctx.rollover) blocks.push("Rollover hours (thin market, wide spreads)");
  if (ctx.isHazard) {
    checks.push({ check: "Breakout hazard hours (12:00-16:00 UTC)", points: -20, passed: true });
    blocks.push("Peak London/NY overlap: Breakout hazard window (S/R breaks 3.2x more frequently)");
  } else if (ctx.is9amPh) {
    checks.push({ check: "Prime 9:00 AM PH Time trading window (01:00 UTC)", points: 20, passed: true });
  } else if (ctx.isLowVolatility) {
    checks.push({ check: "Prime low-volatility S/R hours (20:00-04:00 UTC)", points: 15, passed: true });
  } else {
    checks.push({ check: "Outside low-volatility S/R hours", points: -10, passed: true });
    blocks.push("Outside prime low-volatility window (20:00-04:00 UTC)");
  }

  // S/R alignment and trap detection (Structure & Price Action aware)
  if (ctx.candleSummary?.range_position_pct != null) {
    const isBuy = direction === "BUY";
    const pos = ctx.candleSummary.range_position_pct;
    const structure = ctx.candleSummary.structure || "mixed (ranging)";
    const isDowntrend = structure.includes("downtrend");
    const isUptrend = structure.includes("uptrend");
    const isRanging = !isDowntrend && !isUptrend;
    const boundaryAction = ctx.candleSummary.boundary_action;
    const isNearSupport = pos <= 25;
    const isNearResistance = pos >= 75;

    if (isRanging) {
      if (isBuy && isNearSupport && boundaryAction === "support_bounce_wick") {
        checks.push({ check: "Support bounce: buyer rejection wick defending range floor", points: 15, passed: true });
      } else if (!isBuy && isNearResistance && boundaryAction === "resistance_rejection_wick") {
        checks.push({ check: "Resistance rejection: seller rejection wick defending range ceiling", points: 15, passed: true });
      } else if (!isBuy && isNearSupport && boundaryAction !== "breakdown_momentum") {
        checks.push({ check: "Range trap: selling into range floor without breakdown momentum", points: -20, passed: true });
        blocks.push(`Selling at range support (${pos}% of 6h range): high risk of immediate bounce`);
      } else if (isBuy && isNearResistance && boundaryAction !== "breakout_momentum") {
        checks.push({ check: "Range trap: buying into range ceiling without breakout momentum", points: -20, passed: true });
        blocks.push(`Buying at range resistance (${pos}% of 6h range): high risk of immediate rejection`);
      }
    } else if (isDowntrend) {
      if (!isBuy && isNearSupport) {
        checks.push({ check: "Downtrend continuation: selling with downward momentum", points: 10, passed: true });
      } else if (isBuy && isNearSupport) {
        checks.push({ check: "Falling knife trap: buying into an active downtrend", points: -25, passed: true });
        blocks.push(`Buying against active downtrend at ${pos}% of range: high risk of breakdown`);
      }
    } else if (isUptrend) {
      if (isBuy && isNearResistance) {
        checks.push({ check: "Uptrend continuation: buying with upward momentum", points: 10, passed: true });
      } else if (!isBuy && isNearResistance) {
        checks.push({ check: "Top picking trap: shorting against an active uptrend", points: -25, passed: true });
        blocks.push(`Shorting against active uptrend at ${pos}% of range: high risk of breakout continuation`);
      }
    }
  }

  const total = checks.reduce((sum, c) => sum + (c.passed ? c.points : 0), 0);
  return { score: Math.max(0, Math.min(100, total)), breakdown: checks, blocks };
};
