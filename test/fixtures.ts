/**
 * A `GET /v1/models` body in the API's shape. Standard prices are the live catalog's on 2026-11-14;
 * the priority prices and the last two entries are made up to cover edge cases.
 */
export const CATALOG_BODY = {
  object: "list",
  data: [
    {
      id: "glm-5.3-flash-abliterated",
      object: "model",
      created: 1793664000,
      owned_by: "AbliteratedLLM",
      name: "GLM-5.3 Flash Abliterated",
      context_length: 1048576,
      max_output_tokens: 131072,
      pricing: { input: "0.0977", output: "0.3421", cached_input: "0.0098", priority: null },
      provider_label: null,
      variant: "abliterated",
      input_modalities: ["text", "image"],
      capabilities: { reasoning: true, vision: true, priority_tier: false },
      precision: "FP8",
    },
    {
      id: "deepseek-v4.1-flash-1017",
      object: "model",
      created: 1793664000,
      owned_by: "AbliteratedLLM",
      name: "DeepSeek V4.1 Flash 1017",
      context_length: 1048576,
      max_output_tokens: 1048576,
      pricing: {
        input: "0.27",
        output: "1.08",
        cached_input: "0.0054",
        priority: { input: "0.3375", output: "1.35", cached_input: "0.00675" },
      },
      provider_label: "Stock model",
      variant: "stock",
      input_modalities: ["text", "image"],
      capabilities: { reasoning: true, vision: true, priority_tier: true },
      precision: "FP8",
    },
    {
      id: "glm-5.3",
      object: "model",
      created: 1793664000,
      owned_by: "AbliteratedLLM",
      name: "GLM-5.3",
      context_length: 1048576,
      max_output_tokens: 1048576,
      pricing: { input: "1.26", output: "3.96", cached_input: "0.234", priority: null },
      provider_label: "Stock model",
      variant: "stock",
      input_modalities: ["text"],
      capabilities: { reasoning: true, vision: false, priority_tier: false },
      precision: "FP8",
    },
    // Malformed: a numeric price. Skipped.
    { id: "broken-price", pricing: { input: 1.5, output: "2", cached_input: "0.1" } },
    // Malformed: no id. Skipped.
    { name: "No id", pricing: { input: "1", output: "2", cached_input: "0.1" } },
  ],
};
