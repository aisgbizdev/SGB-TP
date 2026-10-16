// Technical indicators for the TradePilot client-area contract (#8).
// Pure: no DB, no network. Computed from the SAME candles the analysis was
// generated from (the snapshot stored on the analyses row).
import { calculateIndicators, type Candle, type Signal } from "./indicators";

export interface TpIndicator {
  group: "oscillator" | "movingAverage";
  label: string;
  value: string;
  status: "buy" | "sell" | "neutral";
  /** Position on the UI gauge, 0-100 (50 = neutral). */
  marker: number;
}

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));
const status = (s: Signal): TpIndicator["status"] => (s === "Buy" ? "buy" : s === "Sell" ? "sell" : "neutral");
const f2 = (n: number) => n.toFixed(2);

/**
 * The contract's minimum set: RSI(14), MACD(12,26), Stochastic %K,
 * Bollinger(20,2), EMA 9/21/50, SMA 10/20/50/100. Returns [] when there are
 * too few candles (legacy rows, or no candle feed for the instrument).
 *
 * Markers: RSI / %K use their own 0-100 scale; Bollinger uses %B; MACD maps
 * the histogram relative to the MACD/signal spread; each moving average maps
 * the price's distance from it, with +/-2% being the ends of the gauge.
 */
export function computeTpIndicators(instrument: string, candles: Candle[] | null | undefined): TpIndicator[] {
  if (!candles || candles.length < 30) return [];
  // "1h" selects the intraday MA ladder (SMA 10/20/50/100, EMA 9/21/50), which
  // is the set the contract asks for whatever the analysis timeframe is.
  const ind = calculateIndicators(instrument, candles, "1h");
  const close = ind.lastClose;
  const out: TpIndicator[] = [];

  out.push({
    group: "oscillator",
    label: "RSI (14)",
    value: f2(ind.rsi14.value),
    status: status(ind.rsi14.signal),
    marker: Math.round(clamp(ind.rsi14.value, 0, 100)),
  });

  const spread = Math.abs(ind.macd.macd) + Math.abs(ind.macd.signal);
  out.push({
    group: "oscillator",
    label: "MACD (12,26)",
    value: f2(ind.macd.macd),
    status: status(ind.macd.action),
    marker: Math.round(50 + (spread === 0 ? 0 : clamp(ind.macd.histogram / spread, -1, 1) * 50)),
  });

  out.push({
    group: "oscillator",
    label: "Stochastic %K",
    value: f2(ind.stochastic.k),
    status: status(ind.stochastic.signal),
    marker: Math.round(clamp(ind.stochastic.k, 0, 100)),
  });

  const band = ind.bollinger.upper - ind.bollinger.lower;
  out.push({
    group: "oscillator",
    label: "Bollinger (20,2)",
    value: f2(ind.bollinger.middle),
    status: status(ind.bollinger.signal),
    marker: band > 0 ? Math.round(clamp(((close - ind.bollinger.lower) / band) * 100, 0, 100)) : 50,
  });

  for (const ma of ind.movingAverages) {
    out.push({
      group: "movingAverage",
      label: `${ma.type} ${ma.period}`,
      value: f2(ma.value),
      status: status(ma.signal),
      marker: Math.round(50 + clamp((close - ma.value) / ma.value / 0.02, -1, 1) * 50),
    });
  }
  return out;
}
