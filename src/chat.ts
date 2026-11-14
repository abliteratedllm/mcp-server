import * as z from "zod";
import type { TokenCounts } from "./cost.ts";

/**
 * Sent with every request. Without max_tokens the API uses 16384, and the hold placed against the
 * balance and the key's spend cap covers the whole budget, which a capped key may refuse.
 */
export const DEFAULT_MAX_TOKENS = 2048;
export const REASONING_EFFORTS = ["low", "medium", "high"] as const;
export type ReasoningEffort = (typeof REASONING_EFFORTS)[number];
export const DEFAULT_REASONING_EFFORT: ReasoningEffort = "low";

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface ChatArgs {
  prompt?: string | undefined;
  messages?: ChatMessage[] | undefined;
  system?: string | undefined;
  model: string;
  max_tokens: number;
  reasoning_effort: ReasoningEffort;
  temperature?: number | undefined;
}

/** The `POST /v1/chat/completions` body for a tool call. Throws when both or neither of prompt and messages are given. */
export function buildChatRequest(args: ChatArgs): {
  model: string;
  messages: ChatMessage[];
  max_tokens: number;
  reasoning_effort: ReasoningEffort;
  temperature?: number;
} {
  if ((args.prompt === undefined) === (args.messages === undefined)) {
    throw new Error("Pass either prompt or messages (exactly one of them).");
  }
  const messages: ChatMessage[] = args.system === undefined ? [] : [{ role: "system", content: args.system }];
  if (args.prompt !== undefined) messages.push({ role: "user", content: args.prompt });
  else if (args.messages !== undefined) messages.push(...args.messages);
  return {
    model: args.model,
    messages,
    max_tokens: args.max_tokens,
    reasoning_effort: args.reasoning_effort,
    ...(args.temperature === undefined ? {} : { temperature: args.temperature }),
  };
}

const TokenCount = z.number().int().nonnegative();

const ChatCompletion = z.object({
  model: z.string().nullish(),
  choices: z
    .array(
      z.object({
        message: z.object({ content: z.string().nullish() }).nullish(),
        finish_reason: z.string().nullish(),
      }),
    )
    .min(1),
  usage: z
    .object({
      prompt_tokens: TokenCount,
      completion_tokens: TokenCount,
      prompt_tokens_details: z.object({ cached_tokens: TokenCount.nullish() }).nullish(),
      completion_tokens_details: z.object({ reasoning_tokens: TokenCount.nullish() }).nullish(),
    })
    .nullish(),
});

export interface ChatResult {
  model: string | null;
  content: string;
  finish_reason: string | null;
  tokens: TokenCounts | null;
  /** Part of tokens.output_tokens, when the API reports it. */
  reasoning_tokens: number | null;
}

export function parseChatCompletion(body: unknown): ChatResult {
  const parsed = ChatCompletion.safeParse(body);
  if (!parsed.success) {
    throw new Error("Unexpected response from POST /v1/chat/completions: no choices in the body.");
  }
  const { model, choices, usage } = parsed.data;
  const choice = choices[0];
  return {
    model: model ?? null,
    content: choice?.message?.content ?? "",
    finish_reason: choice?.finish_reason ?? null,
    tokens: usage
      ? {
          input_tokens: usage.prompt_tokens,
          cached_input_tokens: Math.min(usage.prompt_tokens_details?.cached_tokens ?? 0, usage.prompt_tokens),
          output_tokens: usage.completion_tokens,
        }
      : null,
    reasoning_tokens: usage?.completion_tokens_details?.reasoning_tokens ?? null,
  };
}

/** The tool result texts: the reply (or why there is none) and a line of request details. */
export function describeChatResult(
  result: ChatResult,
  o: { model: string; maxTokens: number; estimatedCostUsd: string | null },
): { reply: string; details: string; isError: boolean } {
  const cutOff = result.finish_reason === "length";
  let reply = result.content;
  if (reply.trim() === "") {
    reply = cutOff
      ? `No reply: the model used its whole max_tokens budget (${o.maxTokens} tokens, reasoning included) before writing an answer. Raise max_tokens or lower reasoning_effort.`
      : `The model returned an empty reply (finish_reason: ${result.finish_reason ?? "none"}).`;
  }
  const details = [`Model: ${result.model ?? o.model}.`, `Finish reason: ${result.finish_reason ?? "none"}.`];
  if (result.tokens) {
    const t = result.tokens;
    const reasoning = result.reasoning_tokens === null ? "" : `, ${result.reasoning_tokens} of them reasoning`;
    details.push(`Tokens: ${t.input_tokens} input (${t.cached_input_tokens} cached), ${t.output_tokens} output${reasoning}.`);
  } else {
    details.push("Token usage: not reported.");
  }
  if (o.estimatedCostUsd !== null) {
    details.push(`Estimated cost: $${o.estimatedCostUsd} (usage × catalog prices, not the billed amount).`);
  }
  if (cutOff && result.content.trim() !== "") {
    details.push(`The reply was cut off at max_tokens (${o.maxTokens}); reasoning tokens count toward it.`);
  }
  return { reply, details: details.join(" "), isError: result.content.trim() === "" };
}
