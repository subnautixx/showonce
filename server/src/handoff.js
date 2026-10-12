// Assistant ("mcp") mode: instead of calling a model API, the server keeps the latest recording
// until someone hands back a plan: an AI assistant over MCP (mcp.js), or the user pasting a chat AI's answer.
import { randomUUID } from 'node:crypto';
import { config } from './config.js';
import { HttpError } from '../../extension/core/errors.js';
import { SYSTEM_PROMPT } from '../../extension/core/prompt.js';
import { buildParts, planFromText, traceEvents } from '../../extension/core/analyze.js';

let waiting = null; // { id, events, plan }

export function openHandoff(trace) {
  waiting = { id: randomUUID(), events: traceEvents(trace), plan: null };
  return { pending: true, id: waiting.id };
}

/** What the assistant reads: the same instructions and parts an API provider would get. */
export function pendingRecording(images) {
  if (!waiting) {
    throw new HttpError(404, 'No recording is waiting. Ask the user to record a task in the ShowOnce extension and click "Turn it into a workflow".');
  }
  const wanted = Number(images ?? config.maxImages);
  const max = Number.isFinite(wanted) ? Math.max(0, Math.min(wanted, config.maxImages)) : config.maxImages;
  return { id: waiting.id, system: SYSTEM_PROMPT, parts: buildParts(waiting.events, max) };
}

/** Accepts a plan object, or text that contains one (a chat AI's answer). */
export function submitPlan({ plan, text } = {}) {
  const normalized = planFromText(plan && typeof plan === 'object' ? plan : (text ?? plan));
  if (waiting) waiting.plan = normalized;
  return { plan: normalized, delivered: !!waiting };
}

/** Polled by the extension. The recording is dropped once its plan has been collected. */
export function collectPlan(id) {
  if (!waiting || waiting.id !== id) {
    throw new HttpError(404, 'The server no longer has this recording (was it restarted?). Click "Turn it into a workflow" again.');
  }
  if (!waiting.plan) return { pending: true };
  const { plan } = waiting;
  waiting = null;
  return { plan };
}
