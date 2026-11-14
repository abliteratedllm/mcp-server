import * as z from "zod";

const Amount = z.string().nullable();

/**
 * `GET /v1/balance`, also the `get_balance` output. Amounts are USD decimal strings, passed on
 * unchanged because they are exact and floats would not be. A key remainder is null when the key
 * has no cap for that period.
 */
export const Balance = z.object({
  balance_usd: Amount,
  held_usd: Amount,
  available_usd: Amount,
  trial: z.boolean(),
  key_daily_remaining_usd: Amount,
  key_monthly_remaining_usd: Amount,
  key_lifetime_remaining_usd: Amount,
});
export type Balance = z.infer<typeof Balance>;

export function parseBalance(body: unknown): Balance {
  const parsed = Balance.safeParse(body);
  if (!parsed.success) throw new Error("Unexpected response from GET /v1/balance.");
  return parsed.data;
}
