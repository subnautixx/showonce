import { checkedFetch } from './http.js';

export async function complete({ system, parts, model, config }) {
  const content = parts.map((p) => p.type === 'image'
    ? { type: 'image', source: { type: 'base64', media_type: p.mediaType, data: p.data } }
    : { type: 'text', text: p.text });

  const data = await checkedFetch('Claude', 'https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': config.keys.claude,
      'anthropic-version': '2023-06-01',
      // The extension calls the API straight from the browser, with the user's own key.
      'anthropic-dangerous-direct-browser-access': 'true',
    },
    body: JSON.stringify({
      model,
      max_tokens: 8000,
      system,
      messages: [{ role: 'user', content }],
    }),
  });
  return (data.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
}
