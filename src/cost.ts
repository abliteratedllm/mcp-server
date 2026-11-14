import { ceilDiv, fromScaled, toScaled } from "./decimal.ts";

/** Prices in USD per 1M tokens, as the catalog sends them (decimal strings). */
export interface Prices {
  input: string;
  output: string;
  cached_input: string;
}

/** Token counts of one request. `cached_input_tokens` is the part of `input_tokens` read from cache. */
export interface TokenCounts {
  input_tokens: number;
  cached_input_tokens: number;
  output_tokens: number;
}

/** USD amounts as decimal strings. Parts are exact; `total` is rounded up to $0.000001 like billing. */
export interface CostEstimate {
  uncached_input: string;
  cached_input: string;
  output: string;
  total: string;
}

/** Decimals kept from a price string. */
const PRICE_SCALE = 12;
/** tokens × scaled price is in units of 10^-18 USD: 10^-12 from the price, 10^-6 from "per 1M tokens". */
const COST_SCALE = PRICE_SCALE + 6;
/** Billing rounds the request's total up to whole micro-dollars. */
const MICRO_USD = 10n ** BigInt(COST_SCALE - 6);

/**
 * The API's billing formula:
 * (input − cached) × input price + cached × cached-input price + output × output price,
 * per 1M tokens, with the sum rounded up once to $0.000001.
 */
export function estimateCost(prices: Prices, tokens: TokenCounts): CostEstimate {
  for (const [name, count] of Object.entries(tokens)) {
    if (!Number.isSafeInteger(count) || count < 0) {
      throw new RangeError(`${name} must be a whole number of tokens, 0 or more.`);
    }
  }
  if (tokens.cached_input_tokens > tokens.input_tokens) {
    throw new RangeError("cached_input_tokens is part of input_tokens, so it can't be larger.");
  }
  const uncached =
    BigInt(tokens.input_tokens - tokens.cached_input_tokens) * toScaled(prices.input, PRICE_SCALE);
  const cached = BigInt(tokens.cached_input_tokens) * toScaled(prices.cached_input, PRICE_SCALE);
  const output = BigInt(tokens.output_tokens) * toScaled(prices.output, PRICE_SCALE);
  return {
    uncached_input: fromScaled(uncached, COST_SCALE, 6),
    cached_input: fromScaled(cached, COST_SCALE, 6),
    output: fromScaled(output, COST_SCALE, 6),
    total: fromScaled(ceilDiv(uncached + cached + output, MICRO_USD), 6, 6),
  };
}
