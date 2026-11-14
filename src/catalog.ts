import * as z from "zod";
import type { Prices } from "./cost.ts";
import { isDecimal, toScaled } from "./decimal.ts";

/** The service's flagship model and this server's default for `chat`. */
export const DEFAULT_MODEL = "glm-5.3-flash-abliterated";

/** How long a fetched catalog is reused before `GET /v1/models` is called again. */
export const CATALOG_TTL_MS = 5 * 60_000;

const PriceList = z.object({ input: z.string(), output: z.string(), cached_input: z.string() });

/** A catalog model as this server reports it (the `list_models` output). */
export const CatalogModel = z.object({
  id: z.string(),
  name: z.string(),
  variant: z
    .string()
    .nullable()
    .describe('"abliterated": refusal behavior removed from the weights; "stock": the vendor\'s original weights.'),
  context_length: z.number().nullable(),
  max_output_tokens: z.number().nullable(),
  pricing: PriceList.extend({ priority: PriceList.nullable() }).describe(
    "USD per 1M tokens as decimal strings. priority: prices of the priority tier, null when the model has none.",
  ),
  input_modalities: z.array(z.string()),
  capabilities: z.object({ reasoning: z.boolean(), vision: z.boolean(), priority_tier: z.boolean() }),
});
export type CatalogModel = z.infer<typeof CatalogModel>;

export interface ModelFilter {
  variant?: "abliterated" | "stock" | undefined;
  /** true: only models that accept image input; false: only models that don't. */
  vision?: boolean | undefined;
  /** Highest output price to include, in USD per 1M tokens. */
  max_output_price?: number | undefined;
}

const Decimal = z.string().refine(isDecimal);
const ApiPrices = z.object({ input: Decimal, output: Decimal, cached_input: Decimal.nullish() });

/** No cached-input price means cached tokens cost the same as uncached ones. */
function toPrices(p: z.infer<typeof ApiPrices>): Prices {
  return { input: p.input, output: p.output, cached_input: p.cached_input ?? p.input };
}

const Count = z.number().int().positive().nullish();
const Flag = z.boolean().nullish();

/** One entry of `GET /v1/models` `data`, reduced to the fields this server reports. */
const ApiModel = z
  .object({
    id: z.string().min(1),
    name: z.string().nullish(),
    variant: z.string().nullish(),
    context_length: Count,
    max_output_tokens: Count,
    pricing: ApiPrices.extend({ priority: ApiPrices.nullish() }),
    input_modalities: z.array(z.string()).nullish(),
    capabilities: z.object({ reasoning: Flag, vision: Flag, priority_tier: Flag }).nullish(),
  })
  .transform((m): CatalogModel => {
    const modalities = m.input_modalities ?? ["text"];
    const priority = m.pricing.priority ? toPrices(m.pricing.priority) : null;
    return {
      id: m.id,
      name: m.name ?? m.id,
      variant: m.variant ?? null,
      context_length: m.context_length ?? null,
      max_output_tokens: m.max_output_tokens ?? null,
      pricing: { ...toPrices(m.pricing), priority },
      input_modalities: modalities,
      capabilities: {
        reasoning: m.capabilities?.reasoning === true,
        vision: m.capabilities?.vision === true || modalities.includes("image"),
        priority_tier: m.capabilities?.priority_tier === true && priority !== null,
      },
    };
  });

const ApiModelList = z.object({ data: z.array(z.unknown()) });

/** Maps a `GET /v1/models` body to catalog models, skipping entries without an id or valid prices. */
export function parseCatalog(body: unknown): CatalogModel[] {
  const list = ApiModelList.safeParse(body);
  if (!list.success) throw new Error("Unexpected response from GET /v1/models: no data array.");
  return list.data.data.flatMap((entry) => {
    const model = ApiModel.safeParse(entry);
    return model.success ? [model.data] : [];
  });
}

export function filterModels(models: readonly CatalogModel[], filter: ModelFilter): CatalogModel[] {
  const maxOutput =
    filter.max_output_price === undefined ? null : toScaled(filter.max_output_price.toFixed(12), 12);
  return models.filter(
    (m) =>
      (filter.variant === undefined || m.variant === filter.variant) &&
      (filter.vision === undefined || m.input_modalities.includes("image") === filter.vision) &&
      (maxOutput === null || toScaled(m.pricing.output, 12) <= maxOutput),
  );
}

export interface CatalogSnapshot {
  models: CatalogModel[];
  /** Date.now() when the catalog was fetched. */
  fetchedAt: number;
}

/** The public catalog, fetched on first use and reused for `ttlMs`. Concurrent callers share one fetch. */
export class CatalogCache {
  readonly #load: () => Promise<CatalogModel[]>;
  readonly #ttlMs: number;
  readonly #now: () => number;
  #snapshot: CatalogSnapshot | undefined;
  #pending: Promise<CatalogSnapshot> | undefined;

  constructor(
    load: () => Promise<CatalogModel[]>,
    options: { ttlMs?: number; now?: () => number } = {},
  ) {
    this.#load = load;
    this.#ttlMs = options.ttlMs ?? CATALOG_TTL_MS;
    this.#now = options.now ?? Date.now;
  }

  get(): Promise<CatalogSnapshot> {
    const snapshot = this.#snapshot;
    if (snapshot && this.#now() - snapshot.fetchedAt < this.#ttlMs) return Promise.resolve(snapshot);
    this.#pending ??= this.#load()
      .then((models) => {
        this.#snapshot = { models, fetchedAt: this.#now() };
        return this.#snapshot;
      })
      .finally(() => {
        this.#pending = undefined;
      });
    return this.#pending;
  }
}
