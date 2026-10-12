// Every provider exposes: complete({ system, parts, model, config }) -> Promise<string>
// parts: [{ type: 'text', text } | { type: 'image', mediaType, data /* base64 */ }]
import * as claude from './claude.js';
import * as openai from './openai.js';
import * as gemini from './gemini.js';
import * as ollama from './ollama.js';
import * as mock from './mock.js';
import { HttpError } from '../errors.js';

const PROVIDERS = { claude, openai, gemini, ollama, mock };
const KEY_ENV = { claude: 'ANTHROPIC_API_KEY', openai: 'OPENAI_API_KEY', gemini: 'GEMINI_API_KEY' };

export function getProvider(config) {
  const p = PROVIDERS[config.provider];
  if (!p) throw new HttpError(500, `Unknown SHOWONCE_PROVIDER "${config.provider}". Use one of: ${Object.keys(PROVIDERS).join(', ')}`);
  if (KEY_ENV[config.provider] && !config.keys[config.provider]) {
    throw new HttpError(500, `${KEY_ENV[config.provider]} is not set. Add it to server/.env (or run "npm run demo" to try without a key).`);
  }
  return p;
}
