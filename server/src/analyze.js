import { config as defaultConfig } from './config.js';
import { HttpError } from './errors.js';
import { extractJson } from './json.js';
import { normalizePlan } from './plan.js';
import { SYSTEM_PROMPT, eventLog } from './prompt.js';
import { getProvider } from './providers/index.js';

const DATA_URL = /^data:(image\/[a-z+]+);base64,(.+)$/i;

/** Pick at most `max` screenshots, spread evenly across the recording. */
export function sampleScreenshots(events, max) {
  const withShots = events
    .map((ev, i) => ({ i, m: typeof ev.screenshot === 'string' ? ev.screenshot.match(DATA_URL) : null }))
    .filter((x) => x.m);
  if (withShots.length <= max) return withShots;
  const step = withShots.length / max;
  return Array.from({ length: max }, (_, k) => withShots[Math.floor(k * step)]);
}

export function buildParts(events, maxImages) {
  const parts = [{
    type: 'text',
    text: `Here is what the user did, in order:\n\n${eventLog(events)}\n\nScreenshots follow, each labelled with the action it was taken after.`,
  }];
  for (const { i, m } of sampleScreenshots(events, maxImages)) {
    parts.push({ type: 'text', text: `Screenshot after action #${i + 1}:` });
    parts.push({ type: 'image', mediaType: m[1].toLowerCase(), data: m[2] });
  }
  parts.push({ type: 'text', text: 'Now return the JSON plan.' });
  return parts;
}

export function traceEvents(trace) {
  const events = Array.isArray(trace?.events) ? trace.events.filter((e) => e && typeof e === 'object') : [];
  if (!events.length) throw new HttpError(400, 'The recording is empty.');
  return events;
}

export async function analyzeTrace(trace, config = defaultConfig) {
  const events = traceEvents(trace);
  const provider = getProvider(config);
  const raw = await provider.complete({
    system: SYSTEM_PROMPT,
    parts: buildParts(events, config.maxImages),
    model: config.model,
    config,
  });

  let parsed;
  try {
    parsed = extractJson(raw);
  } catch (err) {
    throw new HttpError(502, `The model did not return a valid plan (${err.message}). Try again or use a stronger model.`);
  }
  return normalizePlan(parsed);
}
