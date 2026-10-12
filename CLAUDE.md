# ShowOnce

Record a task once in the browser → a vision model infers the intent → a deterministic builder emits an importable n8n workflow.

## Layout
- `extension/` Chrome MV3 extension (plain JS, no build step)
  - `content.js` records clicks/inputs/copy/paste; redacts sensitive fields in the page
  - `background.js` stores events in `chrome.storage.local`, screenshots via `captureVisibleTab`, calls the server
  - `popup.*` record controls + plan review (variables, trigger) + deploy/download + "any chat AI" copy/paste
- `server/` zero-dependency Node (>=18.17, ESM)
  - `src/app.js` HTTP routes: `GET /health`, `POST /analyze`, `POST /build`, `POST /deploy`, plus the no-key ones (`GET /recording`, `POST /plan`, `GET /plan`, `POST /prompt`); only extension origins allowed
  - `src/prompt.js` system prompt + event log formatting (the plan schema lives here)
  - `src/plan.js` validates/normalizes the model's plan
  - `src/builder.js` plan → n8n nodes; one factory per step kind in `STEP_FACTORIES`
  - `src/providers/` claude (default), openai, gemini, ollama, mock
  - `src/handoff.js` provider `mcp`: `/analyze` parks the recording until a plan is handed back (the popup polls `GET /plan`)
  - `src/mcp.js` stdio MCP server (`get_recording`, `submit_plan`); bridges to the HTTP server, hosting one if none runs. Registered in `.mcp.json`
  - `src/n8n.js` creates the workflow through the n8n public API

## Commands (run in `server/`)
- `npm test` — node:test, must stay green
- `npm run demo` — server with the mock provider (no API key)
- `npm start` — real provider from `.env` (copy `.env.example`)

## Conventions
- Keep the server dependency-free.
- The model never writes raw n8n JSON; it returns a plan with step kinds, and `builder.js` produces nodes.
- Adding a step kind: add it to `STEP_KINDS` (plan.js), document params in `SYSTEM_PROMPT` (prompt.js), add a factory in `builder.js`, add a test.
- Node type versions in builder.js were checked against n8n-nodes-base 2.15.1.
- Never record secrets: extend the `SENSITIVE` regex / `isSensitive` in content.js rather than filtering on the server.

## Status
v0.1. Works in a real Chrome: record → plan (demo provider, and MCP with Claude as the assistant) → review → Download JSON. The copy/paste path is covered by tests and a fake-`chrome` harness only. Importing or deploying to n8n and running a generated workflow are untested. Next: launch GIF (`docs/demo.gif`), real-world testing, more step kinds.
