import { config as defaultConfig } from './config.js';
import { HttpError } from './errors.js';

/** Creates the workflow in n8n through its public API. Returns { id, url }. */
export async function deployWorkflow(workflow, config = defaultConfig) {
  if (!config.n8nUrl || !config.n8nApiKey) {
    throw new HttpError(400, 'Set N8N_URL and N8N_API_KEY in server/.env to create workflows directly, or use "Download JSON" and import it in n8n.');
  }
  // The API rejects unknown top-level fields, so send exactly these.
  const body = {
    name: workflow.name,
    nodes: workflow.nodes,
    connections: workflow.connections,
    settings: workflow.settings || {},
  };
  let res;
  try {
    res = await fetch(`${config.n8nUrl}/api/v1/workflows`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'X-N8N-API-KEY': config.n8nApiKey },
      body: JSON.stringify(body),
    });
  } catch (err) {
    throw new HttpError(502, `Could not reach n8n at ${config.n8nUrl}: ${err.message}`);
  }
  const text = await res.text();
  if (!res.ok) throw new HttpError(502, `n8n refused the workflow (${res.status}): ${text.slice(0, 400)}`);
  const data = JSON.parse(text);
  return { id: data.id, url: `${config.n8nUrl}/workflow/${data.id}` };
}
