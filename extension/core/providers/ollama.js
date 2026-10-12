import { checkedFetch } from './http.js';

// Local models via Ollama (free and private; less accurate on complex UIs today).
export async function complete({ system, parts, model, config }) {
  const text = parts.filter((p) => p.type === 'text').map((p) => p.text).join('\n');
  const images = parts.filter((p) => p.type === 'image').map((p) => p.data);

  const data = await checkedFetch('Ollama', `${config.ollamaUrl}/api/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model,
      stream: false,
      format: 'json',
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: text, images },
      ],
    }),
  });
  return data.message?.content || '';
}
