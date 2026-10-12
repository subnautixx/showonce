import { HttpError } from './errors.js';

export const STEP_KINDS = [
  'gmail.search', 'gmail.send', 'sheets.read', 'sheets.append',
  'http.request', 'telegram.send', 'transform', 'browser',
];
export const TRIGGER_TYPES = ['manual', 'schedule', 'webhook', 'gmail'];

export const varName = (s) =>
  String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/^_+|_+$/g, '') || 'value';

const str = (v, fallback = '') => (v === undefined || v === null ? fallback : String(v));

export function normalizeVariables(list) {
  const seen = new Set();
  return (Array.isArray(list) ? list : []).flatMap((v) => {
    if (!v || typeof v !== 'object') return [];
    const name = varName(v.name);
    if (seen.has(name)) return [];
    seen.add(name);
    return [{
      name,
      example: str(v.example),
      description: str(v.description),
      dynamic: v.dynamic === undefined ? true : !!v.dynamic,
    }];
  });
}

export function normalizeTrigger(t) {
  const type = TRIGGER_TYPES.includes(t?.type) ? t.type : 'manual';
  const out = { type };
  if (type === 'schedule') out.cron = str(t.cron).trim() || '0 9 * * 1-5';
  if (type === 'gmail') out.gmailQuery = str(t.gmailQuery);
  return out;
}

/** Validates and cleans a plan coming from a model (or from the extension). */
export function normalizePlan(raw) {
  if (!raw || typeof raw !== 'object') throw new HttpError(422, 'Plan must be an object');
  const steps = (Array.isArray(raw.steps) ? raw.steps : [])
    .filter((s) => s && typeof s === 'object')
    .map((s) => {
      const kind = STEP_KINDS.includes(s.kind) ? s.kind : 'browser';
      const params = s.params && typeof s.params === 'object' ? s.params : {};
      // Unknown kinds become manual steps so nothing the user did is silently lost.
      if (kind !== s.kind && !params.instructions) {
        params.instructions = `${s.kind}: ${s.description || JSON.stringify(s.params || {})}`;
      }
      return { kind, description: str(s.description), params };
    });
  if (!steps.length) throw new HttpError(422, 'The model could not find any steps in this recording');
  return {
    title: str(raw.title, 'ShowOnce workflow').slice(0, 120) || 'ShowOnce workflow',
    summary: str(raw.summary),
    trigger: normalizeTrigger(raw.trigger),
    variables: normalizeVariables(raw.variables),
    steps,
    confidence: typeof raw.confidence === 'number' ? Math.max(0, Math.min(1, raw.confidence)) : null,
    questions: (Array.isArray(raw.questions) ? raw.questions : []).map(String).filter(Boolean),
  };
}
