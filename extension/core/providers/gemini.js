import { checkedFetch } from './http.js';

export async function complete({ system, parts, model, config }) {
  const geminiParts = parts.map((p) => p.type === 'image'
    ? { inline_data: { mime_type: p.mediaType, data: p.data } }
    : { text: p.text });

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;
  const data = await checkedFetch('Gemini', url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-goog-api-key': config.keys.gemini },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: system }] },
      contents: [{ role: 'user', parts: geminiParts }],
      generationConfig: { responseMimeType: 'application/json' },
    }),
  });
  return (data.candidates?.[0]?.content?.parts || []).map((p) => p.text || '').join('');
}
