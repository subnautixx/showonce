import { checkedFetch } from './http.js';

// Works with OpenAI and any OpenAI-compatible endpoint (OPENAI_BASE_URL).
export async function complete({ system, parts, model, config }) {
  const content = parts.map((p) => p.type === 'image'
    ? { type: 'image_url', image_url: { url: `data:${p.mediaType};base64,${p.data}` } }
    : { type: 'text', text: p.text });

  const data = await checkedFetch('OpenAI', `${config.openaiBaseUrl}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${config.keys.openai}` },
    body: JSON.stringify({
      model,
      max_completion_tokens: 8000,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content },
      ],
    }),
  });
  return data.choices?.[0]?.message?.content || '';
}
