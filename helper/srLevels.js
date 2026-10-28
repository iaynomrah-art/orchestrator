// Support/resistance for the delayed-hedge rule, shared by the live signal
// (signalHelper) and the past-data replay (scripts/replayRules.js) so both see the
// same levels: the lowest low and highest high of the last 12 hours of 5-minute
// bars, or of the last 6 hours after a pump or dump (one hour in those 12 moved at
// least PUMP_MULTIPLE times a typical hour).

export const SR_HOURS = 12;
export const PUMP_MULTIPLE = 6;
// Fewer 5-minute bars than this in the 12 hours (weekend, gap, recorder down): no levels
const MIN_BARS = 120;

/**
 * @param {{time: number, high: number, low: number, close: number}[]} bars 5-minute bars, oldest first (time in seconds)
 * @param {number} nowSec  only bars that started before this count (the current bar is still forming)
 * @returns {{pump: boolean, hours: number, support: number, resistance: number, range: number} | null}
 */
export const srLevels = (bars, nowSec) => {
  const window = bars.filter((b) => b.time >= nowSec - SR_HOURS * 3600 && b.time < nowSec);
  if (window.length < MIN_BARS) return null;
  const moves = [];
  for (let k = 12; k < window.length; k++) moves.push(Math.abs(window[k].close - window[k - 12].close));
  const median = [...moves].sort((a, b) => a - b)[Math.floor(moves.length / 2)];
  const pump = Math.max(...moves) >= PUMP_MULTIPLE * median;
  const used = pump ? window.filter((b) => b.time >= nowSec - 6 * 3600) : window;
  const support = Math.min(...used.map((b) => b.low)), resistance = Math.max(...used.map((b) => b.high));
  return { pump, hours: pump ? 6 : 12, support, resistance, range: resistance - support };
};
