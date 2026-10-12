import http from 'node:http';
import { config } from './config.js';
import { HttpError } from '../../extension/core/errors.js';
import { analyzeTrace, traceEvents } from '../../extension/core/analyze.js';
import { buildWorkflow } from '../../extension/core/builder.js';
import { checkN8n, deployWorkflow } from '../../extension/core/n8n.js';
import { chatPrompt } from '../../extension/core/prompt.js';
import { openHandoff, pendingRecording, submitPlan, collectPlan } from './handoff.js';
import './providers/mock.js';

// What the popup connected wins; server/.env is the fallback.
const n8nOf = (n8n) => ({ url: n8n?.url || config.n8nUrl, apiKey: n8n?.apiKey || config.n8nApiKey });

const MAX_BODY = 60 * 1024 * 1024; // recordings carry screenshots

function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) { reject(new HttpError(413, 'Recording too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); }
      catch { reject(new HttpError(400, 'Invalid JSON body')); }
    });
    req.on('error', reject);
  });
}

// Only the browser extension (or local tools like curl) may call this server.
// A random website you visit must not be able to drive it.
function originAllowed(origin) {
  return !origin || origin.startsWith('chrome-extension://') || origin.startsWith('moz-extension://');
}

function send(res, status, data, origin) {
  const headers = { 'content-type': 'application/json; charset=utf-8' };
  if (origin && originAllowed(origin)) {
    Object.assign(headers, {
      'access-control-allow-origin': origin,
      'access-control-allow-methods': 'GET, POST, OPTIONS',
      'access-control-allow-headers': 'content-type',
      vary: 'origin',
    });
  }
  res.writeHead(status, headers);
  res.end(status === 204 ? undefined : JSON.stringify(data));
}

const routes = {
  'GET /health': async () => ({ ok: true, provider: config.provider, model: config.model, n8n: !!(config.n8nUrl && config.n8nApiKey) }),
  // In assistant mode the plan comes later, from whoever picks the recording up (see handoff.js).
  'POST /analyze': async (body) => (config.provider === 'mcp' ? openHandoff(body) : { plan: await analyzeTrace(body, config) }),
  'GET /recording': async ({ images }) => pendingRecording(images),
  'POST /plan': async (body) => submitPlan(body),
  'GET /plan': async ({ id }) => collectPlan(id),
  'POST /prompt': async (body) => ({ prompt: chatPrompt(traceEvents(body)) }),
  'POST /build': async ({ plan, variables, trigger }) => ({ workflow: buildWorkflow(plan, { variables, trigger }) }),
  // `n8n` ({ url, apiKey }) is what the user connected in the popup; without it server/.env is used.
  'POST /n8n/check': async ({ n8n }) => checkN8n(n8nOf(n8n)),
  'POST /deploy': async ({ plan, variables, trigger, n8n }) => {
    const workflow = buildWorkflow(plan, { variables, trigger });
    return { ...(await deployWorkflow(workflow, n8nOf(n8n))), workflow };
  },
};

export const server = http.createServer(async (req, res) => {
  const origin = req.headers.origin;
  if (!originAllowed(origin)) return send(res, 403, { error: 'Origin not allowed' });
  if (req.method === 'OPTIONS') return send(res, 204, null, origin);

  const url = new URL(req.url, 'http://x');
  const path = url.pathname.replace(/\/+$/, '') || '/';
  const handler = routes[`${req.method} ${path}`];
  if (!handler) return send(res, 404, { error: 'Not found' }, origin);

  const started = Date.now();
  try {
    // GET handlers receive the query string the same way POST handlers receive the body.
    const body = req.method === 'POST' ? await readJson(req) : Object.fromEntries(url.searchParams);
    const result = await handler(body);
    send(res, 200, result, origin);
    console.log(`${req.method} ${path} 200 ${Date.now() - started}ms`);
  } catch (err) {
    const status = err instanceof HttpError ? err.status : 500;
    if (!(err instanceof HttpError)) console.error(err); // expected failures already have a clear message
    send(res, status, { error: err.message }, origin);
    console.log(`${req.method} ${path} ${status} ${Date.now() - started}ms`);
  }
});
