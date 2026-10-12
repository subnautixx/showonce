# ShowOnce

Record a task once in the browser → a vision model infers the intent → a deterministic builder emits an importable n8n workflow.

The extension does all of it by itself. `server/` is an optional helper, needed only when an AI assistant writes the plan over MCP.

## Layout
- `extension/` Chrome MV3 extension (plain JS, ES modules, no build step)
  - `content.js` records clicks/inputs/copy/paste; redacts sensitive fields in the page
  - `background.js` (module service worker) stores events in `chrome.storage.local`, screenshots via `captureVisibleTab`, calls the model. One page change is one `navigate` event: redirects are merged into it, and its title and picture are taken once the page has loaded (`navigated`, `shoot`)
  - `popup.*` Set up checklist (AI + n8n), record controls, plan review (variables, trigger), create/download, "any AI chat" copy/paste. Exactly one button is `.primary` at a time, the next thing to do (`highlightNext`)
  - `docs/demo.html` copies the popup's look for the README animation: after a visual change to the popup, update it and run `node docs/render-demo.mjs`
  - `core/` logic shared with the helper. **No `node:` imports here**: the same files run in Chrome and in Node
    - `prompt.js` system prompt + event log formatting (the plan schema lives here)
    - `plan.js` validates/normalizes the model's plan
    - `builder.js` plan → n8n nodes; one factory per step kind in `STEP_FACTORIES`
    - `analyze.js` recording → plan (`analyzeTrace`, `planFromText`)
    - `providers/` claude, openai, gemini, ollama
    - `n8n.js` checks the connection and creates the workflow through the n8n public API
- `server/` zero-dependency Node helper (>=20, ESM), imports `extension/core/`
  - `src/app.js` HTTP routes: `GET /health`, `POST /analyze`, `POST /build`, `POST /deploy`, `POST /n8n/check`, `GET /recording`, `POST /plan`, `GET /plan`, `POST /prompt`; only extension origins allowed
  - `src/handoff.js` provider `mcp`: `/analyze` parks the recording until a plan is handed back (the popup polls `GET /plan`)
  - `src/mcp.js` stdio MCP server (`get_recording`, `submit_plan`); bridges to the HTTP server, hosting one if none runs. Registered in `.mcp.json`
  - `src/providers/mock.js` canned plan for `npm run demo` (registers itself into the core provider list)
  - `src/cli.js` the `showonce` bin: `npx github:subnautixx/showonce [start|mcp|demo]`

## Settings (all in `chrome.storage.local`)
- `ai`: `{ provider, apiKey, baseUrl, model }`; provider is `chat`, `claude`, `gemini`, `openai`, `ollama` or `mcp`
- `n8n`: `{ url, apiKey }`, saved only after `checkN8n` succeeds
- `serverUrl`: the helper, used only when `ai.provider` is `mcp`

## Commands (run at the repo root)
- `npm test` — node:test, must stay green (also runs on GitHub Actions, Node 20 and 22). `server/test/recorder.test.js` drives `background.js` with a fake `chrome`
- `npm run demo` — helper with the mock provider (no API key)
- `npm start` — helper with the provider from `server/.env` (copy `.env.example`)

## Conventions
- No dependencies, anywhere.
- The model never writes raw n8n JSON; it returns a plan with step kinds, and `builder.js` produces nodes.
- Adding a step kind: add it to `STEP_KINDS` (plan.js), document params in `SYSTEM_PROMPT` (prompt.js), add a factory in `builder.js`, add a label in `popup.js`, add a test.
- Node type versions in builder.js were checked against n8n-nodes-base 2.15.1.
- Never record secrets: extend the `SENSITIVE` regex / `isSensitive` in content.js rather than filtering later.

## Status
v0.2. Verified in a real Chrome on v0.1: record → plan (demo provider, and MCP with Claude as the assistant) → review → Download JSON. The v0.2 serverless extension (model called from the service worker, builder and n8n calls in the popup, Set up checklist) is covered by the tests plus a fake-`chrome` run of the popup, not yet by a real Chrome. Importing or deploying to n8n and running a generated workflow are untested. Next: real-Chrome pass of v0.2, launch GIF (`docs/demo.gif`), more step kinds.
