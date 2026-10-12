// Models sometimes wrap JSON in prose or code fences. Pull out the first JSON object.
export function extractJson(text) {
  if (typeof text !== 'string') throw new Error('Model returned no text');
  const cleaned = text.replace(/```(?:json)?/gi, '').trim();
  try { return JSON.parse(cleaned); } catch {}
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start === -1 || end <= start) throw new Error('Model response did not contain JSON');
  return JSON.parse(cleaned.slice(start, end + 1));
}
