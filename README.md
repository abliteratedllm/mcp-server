# AbliteratedLLM MCP server

`@abliteratedllm/mcp-server` is a [Model Context Protocol](https://modelcontextprotocol.io) server for [AbliteratedLLM](https://abliteratedllm.dev), a pay-per-token, OpenAI-compatible API for abliterated (refusal-removed) and stock open-weight models. It lets an MCP host such as Claude Desktop, Claude Code, Cursor or VS Code list the models and their prices, estimate what a request will cost, check your balance, and send a prompt to a model.

The server runs on your machine over stdio. Your API key stays in your MCP host's configuration and is sent only to `https://api.abliteratedllm.dev`.

## Tools

| Tool | What it does | API key | Spends credit |
| --- | --- | --- | --- |
| `list_models` | Lists the models in the public catalog: id, name, variant, context length, max output tokens, input types, and prices in USD per 1M tokens (input, output, cached input, priority tier where offered). Optional filters: `variant` (`abliterated` or `stock`), `vision`, `max_output_price`. | no | no |
| `estimate_cost` | Prices token counts you supply with the catalog prices and the API's billing formula, rounded up to $0.000001 like billing. Inputs: `model`, `input_tokens`, `output_tokens`, optional `cached_input_tokens` and `priority`. | no | no |
| `get_balance` | Shows the balance of the account that owns the key, the credit held by running requests, whether it is a trial account, and what is left of the key's daily, monthly and lifetime spend caps. Amounts are decimal strings, exactly as the API sends them. It is also the way to check that a key works. | yes | no |
| `chat` | Sends a `prompt` (or a list of `messages`) with an optional `system` prompt to a model and returns its reply, the token usage and an estimated cost. Options: `model` (default `glm-5.3-flash-abliterated`), `max_tokens` (default 2048), `reasoning_effort` (`low`, `medium` or `high`; default `low`), `temperature`. | yes | yes |

Notes:

- `variant: "abliterated"` means the model's refusal behavior was removed from its weights. Models with `variant: "stock"` are the vendors' original weights.
- `chat` is text only and returns one non-streamed reply. It does not pass tools to the model.
- This server has no tokenizer. `estimate_cost` prices the counts you give it, so its result is an estimate. Reasoning tokens are output tokens.
- The catalog is fetched from `GET https://api.abliteratedllm.dev/v1/models` without a key and reused for 5 minutes.

## Requirements

- Node.js 20.3 or later, which includes `npx`.
- For `chat` and `get_balance`: an API key from [abliteratedllm.dev/dashboard/keys](https://abliteratedllm.dev/dashboard/keys). Keys start with `sk-`. A key with a daily spend cap is recommended; caps are set on the same page.

`list_models` and `estimate_cost` work without a key.

## Setup

Each snippet starts the server with `npx -y @abliteratedllm/mcp-server`. Replace `sk-...` with your key, and keep it out of files you commit or share.

### Claude Code

```bash
claude mcp add --scope user --env ABLITERATEDLLM_API_KEY=sk-... abliteratedllm -- npx -y @abliteratedllm/mcp-server
```

`--scope user` saves the server in your user configuration rather than in a project's `.mcp.json`. Run `/mcp` in Claude Code to check that it is connected.

To share the server in a project's `.mcp.json` without the key, let Claude Code expand the variable from your environment:

```json
{
  "mcpServers": {
    "abliteratedllm": {
      "command": "npx",
      "args": ["-y", "@abliteratedllm/mcp-server"],
      "env": { "ABLITERATEDLLM_API_KEY": "${ABLITERATEDLLM_API_KEY}" }
    }
  }
}
```

### Claude Desktop

Open **Settings → Developer → Edit Config**, which opens `claude_desktop_config.json`, and add:

```json
{
  "mcpServers": {
    "abliteratedllm": {
      "command": "npx",
      "args": ["-y", "@abliteratedllm/mcp-server"],
      "env": { "ABLITERATEDLLM_API_KEY": "sk-..." }
    }
  }
}
```

Restart Claude Desktop. On Windows, if the server does not start, use `"command": "cmd"` with `"args": ["/c", "npx", "-y", "@abliteratedllm/mcp-server"]`.

### Cursor

Add the server to `~/.cursor/mcp.json` (all projects) or `.cursor/mcp.json` in a project:

```json
{
  "mcpServers": {
    "abliteratedllm": {
      "command": "npx",
      "args": ["-y", "@abliteratedllm/mcp-server"],
      "env": { "ABLITERATEDLLM_API_KEY": "sk-..." }
    }
  }
}
```

Prefer the file in your home folder, so the key does not end up in a repository.

### VS Code

Run **MCP: Open User Configuration** from the Command Palette (or create `.vscode/mcp.json` in a workspace) and add:

```json
{
  "inputs": [
    {
      "type": "promptString",
      "id": "abliteratedllm-api-key",
      "description": "AbliteratedLLM API key",
      "password": true
    }
  ],
  "servers": {
    "abliteratedllm": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@abliteratedllm/mcp-server"],
      "env": { "ABLITERATEDLLM_API_KEY": "${input:abliteratedllm-api-key}" }
    }
  }
}
```

VS Code asks for the key when the server first starts and stores it, so the key is not written into `mcp.json`. The tools are available in Chat's agent mode.

### Other hosts

Any MCP host that runs local stdio servers works: command `npx`, arguments `-y @abliteratedllm/mcp-server`, and the environment variables below.

## Configuration

| Variable | Default | Description |
| --- | --- | --- |
| `ABLITERATEDLLM_API_KEY` | none | Your API key. Needed for `chat` and `get_balance`. |
| `ABLITERATEDLLM_TIMEOUT_SECONDS` | `55` | How long `chat` waits for a reply, 1 to 600 seconds. See [Timeouts](#timeouts). |

## Costs and limits

- `chat` spends your prepaid AbliteratedLLM credit. Each reply comes with its token usage and an estimated cost: usage times the catalog prices this server fetched. It is labelled as an estimate.
- `chat` always sends `max_tokens`, 2048 unless you pass another value. Without it the API would use 16384. While a request runs, its whole `max_tokens` budget is held against your balance and the key's spend caps, so a large budget can be refused by a capped key even if the reply would be short. Reasoning tokens count toward `max_tokens` and are billed at the output price.
- `reasoning_effort` defaults to `low`, which keeps replies faster and cheaper. If a reply comes back empty because reasoning used the whole budget, `chat` says so; raise `max_tokens` or lower `reasoning_effort`.
- Trial accounts (before the first top-up) allow 1 request at a time and 10 requests per minute per key, and cap output at 4096 tokens per request. See [Rate limits and trial](https://abliteratedllm.dev/docs/rate-limits).
- API errors come back as tool errors with the API's code and what to do about it: a rejected key, low balance (`insufficient_balance`), a spend cap (`key_spend_cap_reached`), rate limits and busy models (with the `Retry-After` time). The server does not retry on its own.
- Your MCP host decides when to call tools. Most hosts ask before running a tool; keep that approval on for `chat`, since it spends credit.

Prices: [abliteratedllm.dev/pricing](https://abliteratedllm.dev/pricing), or call `list_models`.

## Timeouts

`chat` waits for one complete reply. Many MCP hosts, including Claude Desktop, Cursor and others that keep the MCP SDK's default, stop a tool call after 60 seconds. So by default the server stops waiting after 55 seconds and returns an explanation instead of a bare host timeout.

A request that is stopped is billed for its estimated input and any output the model generated before it stopped. Keep `max_tokens` and `reasoning_effort` modest, or pick a faster model, if replies take long.

If your host allows longer tool calls, raise `ABLITERATEDLLM_TIMEOUT_SECONDS`, up to 600 (the API's own limit per request is 10 minutes). Claude Code's CLI, for example, waits much longer than 60 seconds by default (see its `MCP_TOOL_TIMEOUT` setting):

```bash
claude mcp add --scope user --env ABLITERATEDLLM_API_KEY=sk-... --env ABLITERATEDLLM_TIMEOUT_SECONDS=300 abliteratedllm -- npx -y @abliteratedllm/mcp-server
```

While `chat` waits, it sends a progress notification every 10 seconds to hosts that request progress.

The server also handles the API's long-request format: a non-streaming response still running after 90 seconds starts with status 200 and newlines, and an error after that point arrives inside the 200 body. The server checks the body for an `error` member whatever the status.

## Privacy

- `chat` sends your prompt, messages and system prompt to `https://api.abliteratedllm.dev`. `get_balance` sends only the key. `list_models` and `estimate_cost` send no key and no prompt.
- AbliteratedLLM does not store prompts or outputs; see [Privacy](https://abliteratedllm.dev/privacy) for the scope.
- The server writes no files and keeps nothing between runs. It logs one startup line to stderr, which never includes the key.
- AbliteratedLLM is for adults (18+). Its [acceptable use policy](https://abliteratedllm.dev/acceptable-use) applies to everything you send.

## Development

```bash
npm install
npm run build       # compile src/ to dist/
npm test            # unit tests (node:test; needs Node 22.18 or later to run the TypeScript tests directly)
npm run typecheck   # type-check src/ and test/
npm run smoke       # start dist/index.js over stdio without a key: tools/list, list_models, estimate_cost, get_balance refusal
```

`npm run smoke` reads the public catalog, so it needs network access but no key. With a key in `ABLITERATEDLLM_API_KEY`, `npm run smoke -- --live` also calls `get_balance` and sends one small `chat` request, which spends a little credit.

To try the tools by hand, the MCP Inspector works too: `npx @modelcontextprotocol/inspector node dist/index.js`.

## Links

- [API documentation](https://abliteratedllm.dev/docs)
- [Pricing](https://abliteratedllm.dev/pricing)
- [API keys](https://abliteratedllm.dev/dashboard/keys)
- Support: support@abliteratedllm.dev

## License

MIT
