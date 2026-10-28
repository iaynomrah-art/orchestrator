// Shared by the past-data scripts (replaySignals, replayRules): MT5 CSV loading,
// the broker clock, and the indicators the AI sees, rebuilt at a past moment.
import fs from "fs";

export const lowerBound = (arr, x) => { let lo = 0, hi = arr.length; while (lo < hi) { const mid = (lo + hi) >> 1; if (arr[mid] < x) lo = mid + 1; else hi = mid; } return lo; };

export const loadCsv = (path) => {
  const [header, ...lines] = fs.readFileSync(path, "utf8").trim().split(/\r?\n/);
  const cols = header.split(",");
  const idx = (c) => cols.indexOf(c);
  const out = { time: [], open: [], high: [], low: [], close: [] };
  for (const line of lines) {
    const v = line.split(",");
    for (const k of Object.keys(out)) out[k].push(Number(v[idx(k)]));
  }
  return out;
};

// ── broker clock (New York + 7h, the usual MT5 server time) ─────────────────
const nyOffset = (utcMs) => {
  const d = new Date(utcMs);
  const y = d.getUTCFullYear();
  const nthSunday = (month, n) => {
    const first = new Date(Date.UTC(y, month, 1));
    return 1 + ((7 - first.getUTCDay()) % 7) + 7 * (n - 1);
  };
  const start = Date.UTC(y, 2, nthSunday(2, 2), 7);
  const end = Date.UTC(y, 10, nthSunday(10, 1), 6);
  return utcMs >= start && utcMs < end ? -4 : -5;
};
export const serverToUtcMs = (serverSec) => {
  const guess = serverSec * 1000 - 3 * 3600 * 1000;
  return serverSec * 1000 - (nyOffset(guess) + 7) * 3600 * 1000;
};

// ── indicators (TradingView definitions where public) ───────────────────────
const sma = (a, p, i) => (i + 1 < p ? NaN : a.slice(i + 1 - p, i + 1).reduce((s, x) => s + x, 0) / p);
const emaSeries = (a, p) => {
  const k = 2 / (p + 1);
  const out = [];
  a.forEach((x, i) => out.push(i === 0 ? x : x * k + out[i - 1] * (1 - k)));
  return out;
};
const wilder = (a, p) => {
  const out = [];
  a.forEach((x, i) => out.push(i === 0 ? x : (out[i - 1] * (p - 1) + x) / p));
  return out;
};

export const indicatorsAt = (bars, i) => {
  // The last 600 candles are plenty for a 200-period average and the EMA/Wilder warm-up
  const from = Math.max(0, i + 1 - 600);
  const c = bars.close.slice(from, i + 1), h = bars.high.slice(from, i + 1), l = bars.low.slice(from, i + 1);
  const n = c.length;
  if (n < 210) return null;
  const tr = c.map((x, j) => (j === 0 ? h[j] - l[j] : Math.max(h[j] - l[j], Math.abs(h[j] - c[j - 1]), Math.abs(l[j] - c[j - 1]))));
  const atr = wilder(tr, 14)[n - 1];
  const gains = c.map((x, j) => (j === 0 ? 0 : Math.max(0, x - c[j - 1])));
  const losses = c.map((x, j) => (j === 0 ? 0 : Math.max(0, c[j - 1] - x)));
  const ag = wilder(gains, 14), al = wilder(losses, 14);
  const rsiAt = (j) => (al[j] === 0 ? 100 : 100 - 100 / (1 + ag[j] / al[j]));
  const rsi = rsiAt(n - 1), rsiPrev = rsiAt(n - 2);
  const ema26 = emaSeries(c, 26);
  const macdLine = emaSeries(c, 12).map((x, j) => x - ema26[j]);
  const macdSignal = emaSeries(macdLine, 9);
  const price = c[n - 1];

  // Rating ~ TradingView's: average of moving-average votes and oscillator votes
  const maVotes = [];
  for (const p of [10, 20, 30, 50, 100, 200]) {
    const s = sma(c, p, n - 1), e = emaSeries(c, p)[n - 1];
    maVotes.push(Math.sign(price - s), Math.sign(price - e));
  }
  const hh = Math.max(...h.slice(-14)), ll = Math.min(...l.slice(-14));
  const k = hh === ll ? 50 : ((price - ll) / (hh - ll)) * 100;
  const wr = k - 100;
  const wrPrev = (() => {
    const h2 = Math.max(...h.slice(-15, -1)), l2 = Math.min(...l.slice(-15, -1));
    return h2 === l2 ? -50 : ((c[n - 2] - l2) / (h2 - l2)) * 100 - 100;
  })();
  const tp = c.map((x, j) => (h[j] + l[j] + x) / 3);
  const cciAt = (j) => {
    const win = tp.slice(j - 19, j + 1);
    const m = win.reduce((s, x) => s + x, 0) / 20;
    const md = win.reduce((s, x) => s + Math.abs(x - m), 0) / 20;
    return md === 0 ? 0 : (tp[j] - m) / (0.015 * md);
  };
  const cci = cciAt(n - 1), cciPrev = cciAt(n - 2);
  const mom = price - c[n - 11], momPrev = c[n - 2] - c[n - 12];
  const oscVotes = [
    rsi < 30 && rsi > rsiPrev ? 1 : rsi > 70 && rsi < rsiPrev ? -1 : 0,
    k < 20 ? 1 : k > 80 ? -1 : 0,
    cci < -100 && cci > cciPrev ? 1 : cci > 100 && cci < cciPrev ? -1 : 0,
    Math.sign(mom - momPrev),
    Math.sign(macdLine[n - 1] - macdSignal[n - 1]),
    wr < -80 && wr > wrPrev ? 1 : wr > -20 && wr < wrPrev ? -1 : 0,
  ];
  const avg = (a) => a.reduce((s, x) => s + x, 0) / a.length;
  const recommendAll = (avg(maVotes) + avg(oscVotes)) / 2;
  const decision = recommendAll >= 0 ? "BUY" : "SELL";
  const buyVotes = [...maVotes, ...oscVotes].filter((v) => v > 0).length;
  const sellVotes = [...maVotes, ...oscVotes].filter((v) => v < 0).length;
  return {
    decision,
    process: `Analyzed 18 indicators (replay approximation). Results: ${buyVotes} BUY, ${sellVotes} SELL. Verdict: ${decision}.`,
    price: Math.round(price * 100) / 100,
    raw_rsi: Math.round(rsi * 100) / 100,
    recommend_all: recommendAll,
    atr: Math.round(atr * 100) / 100,
    sma_200: Math.round(sma(c, 200, n - 1) * 100) / 100,
  };
};

// Daily candles from the hourly ones (broker day = New York 17:00, like TradingView's gold daily)
export const dailyFromHourly = (h1) => {
  const d1 = { time: [], open: [], high: [], low: [], close: [] };
  h1.time.forEach((t, i) => {
    const day = Math.floor(t / 86400);
    const last = d1.time.length - 1;
    if (last < 0 || Math.floor(d1.time[last] / 86400) !== day) {
      d1.time.push(day * 86400); d1.open.push(h1.open[i]); d1.high.push(h1.high[i]); d1.low.push(h1.low[i]); d1.close.push(h1.close[i]);
    } else {
      d1.high[last] = Math.max(d1.high[last], h1.high[i]); d1.low[last] = Math.min(d1.low[last], h1.low[i]); d1.close[last] = h1.close[i];
    }
  });
  return d1;
};
