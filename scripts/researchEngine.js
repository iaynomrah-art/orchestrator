// Quantitative Research Engine for S/R, TV, Spike vs Constant Move Dynamics
import { loadCsv, serverToUtcMs, indicatorsAt, lowerBound } from './replayData.js';
import { walk } from '../helper/gradeHelper.js';
import { scoreboard } from '../helper/shadowResultsHelper.js';

const m5 = loadCsv('data/XAUUSD.r_M5.csv');
const h1 = loadCsv('data/XAUUSD.r_H1.csv');

console.log('Dataset loaded: M5 candles =', m5.time.length, 'H1 candles =', h1.time.length);

const PUMP_MULTIPLE = 6;
const levelsAt = (i0) => {
  const t = m5.time[i0];
  const from12 = lowerBound(m5.time, t - 12 * 3600);
  if (i0 - from12 < 120) return null;
  const closes = m5.close.slice(from12, i0);
  const moves = [];
  for (let k = 12; k < closes.length; k++) moves.push(Math.abs(closes[k] - closes[k - 12]));
  const median = [...moves].sort((a, b) => a - b)[Math.floor(moves.length / 2)];
  const pump = Math.max(...moves) >= PUMP_MULTIPLE * median;
  const actualFrom = pump ? lowerBound(m5.time, t - 6 * 3600) : from12;
  const highs = m5.high.slice(actualFrom, i0);
  const lows = m5.low.slice(actualFrom, i0);
  const support = Math.min(...lows), resistance = Math.max(...highs);
  return { pump, hours: pump ? 6 : 12, support, resistance, range: resistance - support };
};

// Gather all 9:00 AM PHT moments
const moments9am = [];
for (let t = Math.ceil((m5.time[0] + 2 * 86400) / 3600) * 3600 + 300; t < m5.time[m5.time.length - 1] - 9 * 3600; t += 3600) {
  const utcMs = serverToUtcMs(t);
  const d = new Date(utcMs);
  if (d.getUTCHours() !== 1) continue; // 9:00 AM PHT
  const i0 = lowerBound(m5.time, t);
  if (i0 >= m5.time.length || m5.time[i0] - t > 600) continue;
  const lv = levelsAt(i0);
  const micro = indicatorsAt(h1, lowerBound(h1.time, t - 300) - 1);
  if (!lv || !micro) continue;
  moments9am.push({ t, i0, lv, micro, date: d.toISOString().slice(0, 10) });
}

// Gather all 3 session moments: 9:00 AM PHT (01:00 UTC), 3:00 PM PHT (07:00 UTC), 8:00 PM PHT (12:00 UTC)
const momentsAllSessions = [];
for (let t = Math.ceil((m5.time[0] + 2 * 86400) / 3600) * 3600 + 300; t < m5.time[m5.time.length - 1] - 9 * 3600; t += 3600) {
  const utcMs = serverToUtcMs(t);
  const d = new Date(utcMs);
  const uH = d.getUTCHours();
  if (uH !== 1 && uH !== 7 && uH !== 12) continue; // Asian, London, NY
  const i0 = lowerBound(m5.time, t);
  if (i0 >= m5.time.length || m5.time[i0] - t > 600) continue;
  const lv = levelsAt(i0);
  const micro = indicatorsAt(h1, lowerBound(h1.time, t - 300) - 1);
  if (!lv || !micro) continue;
  momentsAllSessions.push({ t, i0, lv, micro, session: uH === 1 ? 'Asia' : uH === 7 ? 'London' : 'NY', date: d.toISOString().slice(0, 10) });
}

console.log(`Moments found: 9:00 AM PHT = ${moments9am.length}, Multi-Session = ${momentsAllSessions.length}`);

const LOT = 0.03, TARGET = 1000, f = 0.12, budget = TARGET * f, slD = budget / (LOT * 100);
const MAX_LOSS_DOLLARS = 20;
const MAX_TRIG_DIST = (MAX_LOSS_DOLLARS - 2.4) / (LOT * 100);

const evaluateModel = (name, moments, strategyFn) => {
  const records = [];
  moments.forEach(m => {
    const entry = m5.open[m.i0];
    const pos = (entry - m.lv.support) / m.lv.range;
    const res = strategyFn(m, entry, pos);
    if (!res) return;

    const { dir, triggerDistOverride } = res;
    const buffer = 0.50;
    const rawTriggerPx = dir === 'buy' ? m.lv.support - buffer : m.lv.resistance + buffer;
    const triggerDist = triggerDistOverride != null ? triggerDistOverride : Math.max(2.50, Math.min(Math.abs(entry - rawTriggerPx), MAX_TRIG_DIST));
    const trigFraction = Math.max(0.01, Math.min(0.99, triggerDist / slD));
    const tpDistance = Math.max(m.lv.range, 5.0);

    const w = walk(m5, m.i0, dir, slD, tpDistance, trigFraction, 8 * 3600);
    records.push({
      direction: dir,
      entry_price: entry,
      grade: {
        entry_price: entry,
        sl_distance: slD,
        tp_distance: tpDistance,
        results: { ai: { main: w } }
      }
    });
  });

  const b = scoreboard(records, 'main');
  const a = b.ai;
  return {
    name,
    trades: records.length,
    cleanTP: a.a,
    hedgedTP: a.c,
    hedgedSL: a.b,
    winRate: a.a_rate != null ? `${a.a_rate}%` : '0%',
    netPnL: a.pnl != null ? `$${a.pnl}` : '$0'
  };
};

console.log('\n======================================================');
console.log('RESEARCH EXPERIMENT 1: BREAKOUT (CONSTANT MOVE) VS BOUNCE (SPIKE REJECTION)');
console.log('======================================================');

// Baseline S/R Budget (Always assumes bounce at 25%)
const expBaseline = evaluateModel('Baseline S/R (Always Bounces at 25%)', moments9am, (m, entry, pos) => {
  if (m.lv.range * LOT * 100 >= budget) return null;
  if (pos <= 0.25) return { dir: 'buy' };
  if (pos >= 0.75) return { dir: 'sell' };
  return null;
});

// Model A: Adaptive Breakout-or-Bounce:
// If TV disagrees with the bounce (TV momentum is strong through S/R), trade WITH the breakout (constant move)!
// If TV agrees with S/R, trade the bounce!
const expBreakoutFollower = evaluateModel('Adaptive Regime (Breakout if TV disagrees, Bounce if TV agrees)', moments9am, (m, entry, pos) => {
  if (m.lv.range * LOT * 100 >= budget) return null;
  const tv = (m.micro.decision || '').toLowerCase();
  if (pos <= 0.25) {
    // At Support: If TV says BUY -> BOUNCE BUY. If TV says SELL -> BREAKOUT SELL!
    return { dir: tv === 'buy' ? 'buy' : 'sell' };
  }
  if (pos >= 0.75) {
    // At Resistance: If TV says SELL -> BOUNCE SELL. If TV says BUY -> BREAKOUT BUY!
    return { dir: tv === 'sell' ? 'sell' : 'buy' };
  }
  return null;
});

// Model B: High-Conviction Confluence Only (Only trade when S/R and TV agree on the bounce)
const expConfluenceOnly = evaluateModel('High-Conviction Confluence (Only Bounce when TV agrees)', moments9am, (m, entry, pos) => {
  if (m.lv.range * LOT * 100 >= budget) return null;
  const tv = (m.micro.decision || '').toLowerCase();
  if (pos <= 0.25 && tv === 'buy') return { dir: 'buy' };
  if (pos >= 0.75 && tv === 'sell') return { dir: 'sell' };
  return null;
});

// Model C: Spike Exhaustion Filter (Check if previous 1 hour was a rapid spike into S/R)
// If the move in the last hour was > 40% of the entire 12h range, it was a sudden spike (rejection candidate!)
const expSpikeRejection = evaluateModel('Exhaustion Spike Detection (Spike > 40% of 12h range)', moments9am, (m, entry, pos) => {
  if (m.lv.range * LOT * 100 >= budget) return null;
  const prev1hMove = Math.abs(m5.close[m.i0 - 1] - m5.open[m.i0 - 12]);
  const isSpike = prev1hMove / m.lv.range >= 0.40;
  // If sudden spike into level -> High probability mean-reversion bounce
  if (isSpike) {
    if (pos <= 0.25) return { dir: 'buy' };
    if (pos >= 0.75) return { dir: 'sell' };
  }
  return null;
});

console.table([expBaseline, expBreakoutFollower, expConfluenceOnly, expSpikeRejection]);

console.log('\n======================================================');
console.log('RESEARCH EXPERIMENT 2: BUFFER SENSITIVITY (PREVENTING PREMATURE HEDGE TRIPPING)');
console.log('======================================================');

const expBuffers = [0.50, 1.00, 1.50, 2.00, 3.00].map(buf => {
  return evaluateModel(`Buffer $${buf.toFixed(2)} beyond boundary`, moments9am, (m, entry, pos) => {
    if (m.lv.range * LOT * 100 >= budget) return null;
    const tv = (m.micro.decision || '').toLowerCase();
    const isNearSupport = pos <= 0.25, isNearResistance = pos >= 0.75;
    if (!isNearSupport && !isNearResistance) return null;
    const dir = isNearSupport ? 'buy' : 'sell';

    const rawTriggerPx = dir === 'buy' ? m.lv.support - buf : m.lv.resistance + buf;
    const triggerDist = Math.max(2.50, Math.min(Math.abs(entry - rawTriggerPx), MAX_TRIG_DIST));
    return { dir, triggerDistOverride: triggerDist };
  });
});

console.table(expBuffers);

console.log('\n======================================================');
console.log('RESEARCH EXPERIMENT 3: SESSION EXPANSION (ASIAN + LONDON + NY)');
console.log('======================================================');

const expAsiaOnly = evaluateModel('Asian Session Only (9:00 AM PHT)', moments9am, (m, entry, pos) => {
  if (m.lv.range * LOT * 100 >= budget) return null;
  if (pos <= 0.25) return { dir: 'buy' };
  if (pos >= 0.75) return { dir: 'sell' };
  return null;
});

const expAllSessions = evaluateModel('All 3 Sessions (Asia 9am + London 3pm + NY 8pm)', momentsAllSessions, (m, entry, pos) => {
  if (m.lv.range * LOT * 100 >= budget) return null;
  if (pos <= 0.25) return { dir: 'buy' };
  if (pos >= 0.75) return { dir: 'sell' };
  return null;
});

const expAllSessionsTVCombined = evaluateModel('All 3 Sessions: TV + S/R Combined Synergy', momentsAllSessions, (m, entry, pos) => {
  if (m.lv.range * LOT * 100 >= budget) return null;
  const tv = (m.micro.decision || '').toLowerCase();
  if (tv === 'buy' && pos <= 0.45) return { dir: 'buy' };
  if (tv === 'sell' && pos >= 0.55) return { dir: 'sell' };
  return null;
});

console.table([expAsiaOnly, expAllSessions, expAllSessionsTVCombined]);
