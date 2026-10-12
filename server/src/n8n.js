import { config as defaultConfig } from './config.js';
import { HttpError } from './errors.js';

/** The n8n to talk to: what the user connected in the extension, else server/.env. */
function target(n8n, config) {
  const url = String(n8n?.url || config.n8nUrl || '').trim().replace(/\/+$/, '');
  const apiKey = String(n8n?.apiKey || config.n8nApiKey || '').trim();
  if (!url || !apiKey) {
    throw new HttpError(400, 'n8n is not connected yet. Open "Connect n8n" in the ShowOnce popup, or use "Download JSON" and import it in n8n.');
  }
  if (!/^https?:\/\//i.test(url)) throw new HttpError(400, 'The n8n address must start with http:// or https://');
  return { url, apiKey };
}

async function call({ url, apiKey }, path, init = {}) {
  let res;
  try {
    res = await fetch(`${url}/api/v1${path}`, {
      ...init,
      headers: { 'content-type': 'application/json', 'X-N8N-API-KEY': apiKey },
    });
  } catch (err) {
    throw new HttpError(502, `Could not reach n8n at ${url}. Is it running? (${err.message})`);
  }
  const text = await res.text();
  if (res.status === 401 || res.status === 403) {
    throw new HttpError(502, 'n8n did not accept the API key. Create one in n8n: Settings → n8n API.');
  }
  return { res, text };
}

/** Checks the address and key without changing anything in n8n. */
export async function checkN8n(n8n, config = defaultConfig) {
  const to = target(n8n, config);
  const { res, text } = await call(to, '/workflows?limit=1');
  if (!res.ok) throw new HttpError(502, `${to.url} did not answer like n8n (${res.status}): ${text.slice(0, 200)}`);
  return { ok: true, url: to.url };
}

/** Creates the workflow in n8n through its public API. Returns { id, url }. */
export async function deployWorkflow(workflow, n8n, config = defaultConfig) {
  const to = target(n8n, config);
  // The API rejects unknown top-level fields, so send exactly these.
  const body = {
    name: workflow.name,
    nodes: workflow.nodes,
    connections: workflow.connections,
    settings: workflow.settings || {},
  };
  const { res, text } = await call(to, '/workflows', { method: 'POST', body: JSON.stringify(body) });
  if (!res.ok) throw new HttpError(502, `n8n refused the workflow (${res.status}): ${text.slice(0, 400)}`);
  const data = JSON.parse(text);
  return { id: data.id, url: `${to.url}/workflow/${data.id}` };
}
