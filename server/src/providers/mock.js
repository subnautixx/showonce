import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { ROOT } from '../config.js';
import { PROVIDERS } from '../../../extension/core/providers/index.js';

// Returns a canned plan so you can try the whole flow without an API key: npm run demo
export async function complete() {
  return readFile(path.join(ROOT, 'examples', 'sample-plan.json'), 'utf8');
}

PROVIDERS.mock = { complete };
