import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_MODELS } from '../../extension/core/providers/index.js';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Tiny .env loader (zero dependencies). Real environment variables win.
function loadEnv(file) {
  if (!existsSync(file)) return;
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    if (!line.trim() || line.trim().startsWith('#')) continue;
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*(?:\s#.*)?$/);
    if (!m) continue;
    let value = m[2];
    if (/^(['"]).*\1$/.test(value)) value = value.slice(1, -1);
    if (!(m[1] in process.env)) process.env[m[1]] = value;
  }
}

loadEnv(path.join(ROOT, '.env'));

const MODELS = { ...DEFAULT_MODELS, mock: 'mock', mcp: 'your AI assistant' };

const env = process.env;
const provider = (env.SHOWONCE_PROVIDER || 'claude').toLowerCase();

export const config = {
  port: Number(env.PORT || 8787),
  host: env.HOST || '127.0.0.1',
  provider,
  model: env.SHOWONCE_MODEL || MODELS[provider],
  maxImages: Number(env.SHOWONCE_MAX_IMAGES || 20),
  keys: {
    claude: env.ANTHROPIC_API_KEY,
    openai: env.OPENAI_API_KEY,
    gemini: env.GEMINI_API_KEY,
  },
  openaiBaseUrl: (env.OPENAI_BASE_URL || 'https://api.openai.com/v1').replace(/\/+$/, ''),
  ollamaUrl: (env.OLLAMA_URL || 'http://localhost:11434').replace(/\/+$/, ''),
  n8nUrl: (env.N8N_URL || '').replace(/\/+$/, ''),
  n8nApiKey: env.N8N_API_KEY || '',
};
