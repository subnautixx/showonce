import { config } from './config.js';
import { server } from './app.js';

server.listen(config.port, config.host, () => {
  const host = config.host === '127.0.0.1' ? 'localhost' : config.host;
  console.log(`\n  ShowOnce server  http://${host}:${config.port}`);
  console.log(`  model            ${config.provider} / ${config.model}`);
  console.log(`  n8n              ${config.n8nUrl && config.n8nApiKey ? config.n8nUrl : 'not configured (Download JSON still works)'}\n`);
});
