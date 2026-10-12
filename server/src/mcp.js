// MCP server (stdio): lets an AI assistant you already use (Claude Code, Claude Desktop, Cursor...)
// play the model, so no API key is needed. Register it in the MCP client as: node server/src/mcp.js
// It reuses a ShowOnce server that is already running, or hosts one in this process.
import readline from 'node:readline';

process.env.SHOWONCE_PROVIDER = 'mcp';
console.log = console.error; // stdout carries the protocol

const { config } = await import('./config.js');
const { server } = await import('./app.js');

const base = `http://${config.host}:${config.port}`;
const PROTOCOLS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

let starting;
function ensureServer() {
  starting ??= (async () => {
    try { await fetch(`${base}/health`, { signal: AbortSignal.timeout(3000) }); return; } catch { /* nothing there yet */ }
    try {
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(config.port, config.host, () => { server.off('error', reject); resolve(); });
      });
    } catch (err) {
      throw new Error(`Could not reach or start the ShowOnce server on ${base}: ${err.message}`);
    }
    console.error(`ShowOnce server hosted by the MCP connector on ${base}`);
  })().finally(() => { starting = undefined; });
  return starting;
}

async function api(path, body) {
  await ensureServer();
  const res = await fetch(base + path, body === undefined ? undefined : {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `ShowOnce server error ${res.status}`);
  return data;
}

const TOOLS = [
  {
    name: 'get_recording',
    description: 'Fetch the browser recording the user made with the ShowOnce extension and wants turned into an n8n workflow (they clicked "Turn it into a workflow"). Returns the planning instructions, the numbered action log and screenshots. Read it, write the plan, then call submit_plan.',
    inputSchema: {
      type: 'object',
      properties: {
        max_screenshots: { type: 'integer', minimum: 0, maximum: 20, description: 'How many screenshots to include (default 8). Lower it if the result is too large.' },
      },
    },
    async run({ max_screenshots }) {
      const health = await api('/health');
      if (health.provider !== 'mcp') {
        throw new Error(`The ShowOnce server on ${base} runs with provider "${health.provider}", so recordings go to that model instead of to you. Ask the user to stop it (this connector then hosts its own) or to restart it with SHOWONCE_PROVIDER=mcp.`);
      }
      const { system, parts } = await api(`/recording?images=${Number(max_screenshots ?? 8) || 0}`);
      return [
        { type: 'text', text: system },
        ...parts.map((p) => (p.type === 'image'
          ? { type: 'image', data: p.data, mimeType: p.mediaType }
          : { type: 'text', text: p.text })),
        { type: 'text', text: 'Instead of replying with the JSON, pass it as the "plan" argument of the submit_plan tool.' },
      ];
    },
  },
  {
    name: 'submit_plan',
    description: 'Hand the finished plan back to ShowOnce. The user then reviews it in the extension popup and creates or downloads the n8n workflow there.',
    inputSchema: {
      type: 'object',
      properties: {
        plan: { type: 'object', description: 'The JSON plan, in the shape described by get_recording.' },
      },
      required: ['plan'],
    },
    async run({ plan }) {
      const { plan: saved, delivered } = await api('/plan', { plan });
      const what = `"${saved.title}" (${saved.steps.length} step${saved.steps.length === 1 ? '' : 's'})`;
      return [{
        type: 'text',
        text: delivered
          ? `Plan saved: ${what}. Tell the user to open the ShowOnce popup in their browser to review it and create or download the workflow.`
          : `The plan ${what} is valid, but no recording was waiting for it, so the extension will not show it. Ask the user to click "Turn it into a workflow" in the ShowOnce popup, then call get_recording again.`,
      }];
    },
  },
];

const rpcError = (code, message) => Object.assign(new Error(message), { code });

async function handle({ method, params = {} }) {
  switch (method) {
    case 'initialize':
      return {
        protocolVersion: PROTOCOLS.includes(params.protocolVersion) ? params.protocolVersion : PROTOCOLS[0],
        capabilities: { tools: {} },
        serverInfo: { name: 'showonce', version: '0.1.0' },
        instructions: 'ShowOnce turns a task the user recorded in their browser into an n8n workflow. When they ask for that, call get_recording, write the plan it asks for, then call submit_plan.',
      };
    case 'ping':
      return {};
    case 'tools/list':
      return { tools: TOOLS.map(({ run, ...tool }) => tool) };
    case 'tools/call': {
      const tool = TOOLS.find((t) => t.name === params.name);
      if (!tool) throw rpcError(-32602, `Unknown tool: ${params.name}`);
      try { return { content: await tool.run(params.arguments || {}) }; }
      catch (err) { return { content: [{ type: 'text', text: err.message }], isError: true }; }
    }
    default:
      throw rpcError(-32601, `Method not found: ${method}`);
  }
}

const reply = (msg) => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...msg })}\n`);

const lines = readline.createInterface({ input: process.stdin });
lines.on('line', async (line) => {
  if (!line.trim()) return;
  let msg;
  try { msg = JSON.parse(line); }
  catch { return reply({ id: null, error: { code: -32700, message: 'Parse error' } }); }
  if (msg.id === undefined) return; // notifications get no answer
  try { reply({ id: msg.id, result: await handle(msg) }); }
  catch (err) { reply({ id: msg.id, error: { code: Number.isInteger(err.code) ? err.code : -32603, message: err.message } }); }
});
lines.on('close', () => process.exit(0));

// Be reachable for the extension before the assistant makes its first call.
ensureServer().catch((err) => console.error(err.message));
