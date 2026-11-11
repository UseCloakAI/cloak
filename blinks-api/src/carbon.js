// Energy + carbon estimate for one reply.
//
// Nobody outside the datacenter can meter a single request, so this is a
// model, and the UI says so everywhere it shows a number. Every constant is
// here, in one place, so it can be audited and replaced with measured values.
//
// Basis: public per-query figures for hosted LLMs land around 0.2–0.4 Wh for a
// median ~500-token answer on a large model (Google's Aug-2025 Gemini
// disclosure: 0.24 Wh median text prompt; Epoch AI 2025: ~0.3 Wh for a
// GPT-4o-class query). We scale that by model size class and count input
// tokens at a fraction of output tokens (they're processed once, in parallel).
//
// We then over-count on purpose (MARGIN) so the offset target is never short.

// Wh per 1,000 output tokens, by model size class.
export const WH_PER_1K_OUT = { xs: 0.04, s: 0.1, m: 0.25, l: 0.5, xl: 1.2 };
// Input tokens cost this fraction of an output token.
export const INPUT_FACTOR = 0.08;
// Datacenter overhead (cooling, power delivery).
export const PUE = 1.2;
// Grid carbon intensity, gCO2e per kWh. World average, not a clean-grid figure.
export const GRID_G_PER_KWH = 445;
// Safety margin on top of everything: we would rather over-offset.
export const MARGIN = 1.5;

export function estimate({ size = "m", tokensIn = 0, tokensOut = 0 }) {
  const per1k = WH_PER_1K_OUT[size] ?? WH_PER_1K_OUT.m;
  const wh = ((tokensOut + tokensIn * INPUT_FACTOR) / 1000) * per1k * PUE * MARGIN;
  const g = (wh / 1000) * GRID_G_PER_KWH;
  return { wh: round(wh, 4), g: round(g, 4) };
}

// ── Money side ───────────────────────────────────────────────────────────────
// Sponsor cards are sold per thousand views. Until real invoices exist the
// ledger books an estimate at this rate and labels it as an estimate.
export const EST_USD_PER_1K_VIEWS = 4;
export const EST_USD_PER_CLICK = 0.25;
// The pledge: remove this many times the carbon we estimate we emit. Inference
// is cheap to offset (well under 1% of sponsor revenue at 1x), so we go 10x.
export const OFFSET_MULTIPLE = 10;
// Ceiling on how much sponsor revenue the pledge may take. If 10x would cost
// more than this, the ledger shows the shortfall instead of hiding it.
export const CLIMATE_SHARE = 0.5;
// Planning price for verified removal credits, USD per tonne CO2e. Cheap
// avoidance credits cost far less; we budget for removal on purpose.
export const USD_PER_TONNE = 120;

export const METHOD = {
  wh_per_1k_out: WH_PER_1K_OUT,
  input_factor: INPUT_FACTOR,
  pue: PUE,
  grid_g_per_kwh: GRID_G_PER_KWH,
  margin: MARGIN,
  est_usd_per_1k_views: EST_USD_PER_1K_VIEWS,
  est_usd_per_click: EST_USD_PER_CLICK,
  offset_multiple: OFFSET_MULTIPLE,
  climate_share: CLIMATE_SHARE,
  usd_per_tonne: USD_PER_TONNE,
};

function round(n, d) {
  const p = 10 ** d;
  return Math.round(n * p) / p;
}
