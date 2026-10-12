// Every provider exposes: complete({ system, parts, model, config }) -> Promise<string>
// parts: [{ type: 'text', text } | { type: 'image', mediaType, data /* base64 */ }]
import * as claude from './claude.js';
import * as openai from './openai.js';
import * as gemini from './gemini.js';
import * as ollama from './ollama.js';
import { HttpError } from '../errors.js';

// The server adds "mock" here (it reads a file, so it cannot live in the extension).
export const PROVIDERS = { claude, openai, gemini, ollama };

export const DEFAULT_MODELS = {
  claude: 'claude-sonnet-5-5',
  openai: 'gpt-4o',
  gemini: 'gemini-2.5-flash',
  ollama: 'qwen2.5vl',
};

const NEEDS_KEY = { claude: 'Anthropic', openai: 'OpenAI', gemini: 'Gemini' };

export function getProvider(config) {
  const p = PROVIDERS[config.provider];
  if (!p) throw new HttpError(500, `Unknown AI provider "${config.provider}". Use one of: ${Object.keys(PROVIDERS).join(', ')}`);
  if (NEEDS_KEY[config.provider] && !config.keys?.[config.provider]) {
    throw new HttpError(500, `No ${NEEDS_KEY[config.provider]} API key yet. Add it in the ShowOnce popup (Set up → AI), or pick a way that needs no key.`);
  }
  return p;
}
