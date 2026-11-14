/**
 * Exact decimal arithmetic for USD amounts. The API sends prices and balances as decimal strings,
 * so they are scaled to BigInt integers instead of being parsed as floats.
 */

const DECIMAL = /^(\d+)(?:\.(\d+))?$/;

/** `value` × 10^scale as a BigInt. Throws on a negative or malformed value, or on digits past `scale`. */
export function toScaled(value: string, scale: number): bigint {
  const match = DECIMAL.exec(value.trim());
  if (!match) throw new Error(`Not a decimal amount: ${JSON.stringify(value)}`);
  const whole = match[1] ?? "0";
  const fraction = match[2] ?? "";
  if (/[1-9]/.test(fraction.slice(scale))) {
    throw new Error(`${value} has more than ${scale} decimals.`);
  }
  return BigInt(whole + fraction.slice(0, scale).padEnd(scale, "0"));
}

/** True when `value` is a non-negative decimal string. */
export function isDecimal(value: unknown): value is string {
  return typeof value === "string" && DECIMAL.test(value.trim());
}

/**
 * A scaled BigInt as a decimal string, keeping at least `minDecimals` decimals and dropping
 * trailing zeros past them.
 */
export function fromScaled(value: bigint, scale: number, minDecimals = 0): string {
  const negative = value < 0n;
  const digits = (negative ? -value : value).toString().padStart(scale + 1, "0");
  const whole = digits.slice(0, digits.length - scale);
  let fraction = digits.slice(digits.length - scale);
  let end = fraction.length;
  while (end > minDecimals && fraction[end - 1] === "0") end--;
  fraction = fraction.slice(0, end);
  return `${negative ? "-" : ""}${whole}${fraction ? `.${fraction}` : ""}`;
}

/** ⌈a / b⌉ for a ≥ 0 and b > 0. */
export function ceilDiv(a: bigint, b: bigint): bigint {
  return (a + b - 1n) / b;
}
