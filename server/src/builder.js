// Turns a ShowOnce plan into an importable n8n workflow.
import { randomUUID } from 'node:crypto';
import { normalizePlan, normalizeTrigger, normalizeVariables, varName } from './plan.js';

const DX = 260;
const Y = 300;

const PATH = /^[A-Za-z_$][\w$]*(\.[\w$]+)*$/;

// "items.0.id" -> .items[0].id ; anything else (a sheet header with spaces...) is one bracketed key.
const fieldPath = (field) => {
  const f = field.trim();
  if (!PATH.test(f)) return `[${JSON.stringify(f)}]`;
  return f.split('.').map((s) => (/^\d+$/.test(s) ? `[${s}]` : `.${s}`)).join('');
};

const nodeRef = (name) => `$('${name.replace(/[\\']/g, '\\$&')}').first().json`;

function renderText(value, vars, steps) {
  let isExpr = false;
  const text = value.replace(/\{\{\s*(var|prev|step)\s*:\s*([^}]+?)\s*\}\}/g, (match, type, key) => {
    if (type === 'prev') {
      isExpr = true;
      return `{{ $json${fieldPath(key)} }}`;
    }
    if (type === 'step') {
      const m = key.match(/^(\d+)(?:\.(.+))?$/);
      const name = m && steps[Number(m[1]) - 1];
      if (!name) return match;
      isExpr = true;
      return `{{ ${nodeRef(name)}${m[2] ? fieldPath(m[2]) : ''} }}`;
    }
    const v = vars.get(varName(key));
    if (!v) return match;
    if (!v.dynamic) return v.example;
    isExpr = true;
    return `{{ ${nodeRef('Variables')}.${v.name} }}`;
  });
  return { text, isExpr };
}

/**
 * Replace {{var:x}} / {{prev:y}} / {{step:N.y}} placeholders. Returns an n8n expression ("=...") when needed.
 * `steps` holds the node names of the steps placed so far (step 1 first).
 */
export function render(value, vars, steps = []) {
  if (typeof value !== 'string') return value;
  const { text, isExpr } = renderText(value, vars, steps);
  return isExpr ? `=${text}` : text;
}

/** Like render, for a JSON body: inserted values are escaped so the result stays valid JSON. */
export function renderJson(body, vars, steps = []) {
  let isExpr = false;
  const walk = (v) => {
    if (typeof v === 'string') {
      const r = renderText(v, vars, steps);
      isExpr ||= r.isExpr;
      return r.text;
    }
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)]));
    return v;
  };
  // Expressions must reach n8n unescaped; only the literal text around them is JSON-escaped.
  // What an expression yields at run time is unknown here, so n8n escapes it (quotes, line breaks).
  const text = JSON.stringify(walk(body), null, 2).replace(/\{\{ (.*?) \}\}/g, (m, expr) =>
    `{{ JSON.stringify(String(${JSON.parse(`"${expr}"`)} ?? '')).slice(1, -1) }}`);
  return isExpr ? `=${text}` : text;
}

const isMap = (v) => !!v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length > 0;
const renderAll = (obj, t) => Object.fromEntries(Object.entries(obj || {}).map(([k, v]) => [k, t(v)]));
const pairs = (obj, t) => ({ parameters: Object.entries(obj).map(([name, value]) => ({ name, value: t(value) })) });

const noteHeight = (text) => Math.max(260, 60 + 22 * text.split('\n')
  .reduce((lines, line) => lines + Math.max(1, Math.ceil(line.length / 58)), 0));

const slug = (s) => String(s).normalize('NFD').replace(/[̀-ͯ]/g, '')
  .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'showonce';

// ---------- node factories ----------
function triggerNode(trigger, title) {
  switch (trigger.type) {
    case 'schedule':
      return {
        name: 'Schedule',
        type: 'n8n-nodes-base.scheduleTrigger', typeVersion: 1.2,
        parameters: { rule: { interval: [{ field: 'cronExpression', expression: trigger.cron }] } },
      };
    case 'webhook':
      return {
        name: 'Webhook',
        type: 'n8n-nodes-base.webhook', typeVersion: 2,
        webhookId: randomUUID(),
        parameters: { httpMethod: 'POST', path: `${slug(title)}-${randomUUID().slice(0, 6)}`, options: {} },
      };
    case 'gmail':
      return {
        name: 'New email',
        type: 'n8n-nodes-base.gmailTrigger', typeVersion: 1.2,
        parameters: { pollTimes: { item: [{ mode: 'everyMinute' }] }, simple: true, filters: { q: trigger.gmailQuery || '' }, options: {} },
      };
    default:
      return { name: 'Start', type: 'n8n-nodes-base.manualTrigger', typeVersion: 1, parameters: {} };
  }
}

function variablesNode(variables, trigger) {
  return {
    name: 'Variables',
    type: 'n8n-nodes-base.set', typeVersion: 3.4,
    parameters: {
      assignments: {
        assignments: variables.map((v) => ({
          id: randomUUID(),
          name: v.name,
          type: 'string',
          // With a webhook trigger, dynamic values can be passed in the request body.
          value: trigger.type === 'webhook' && v.dynamic
            ? `={{ $json.body.${v.name} ?? ${JSON.stringify(v.example)} }}`
            : v.example,
        })),
      },
      options: {},
    },
  };
}

// Each factory gets the step params and `t`, which renders a templated string (t.json: a JSON body).
const STEP_FACTORIES = {
  'gmail.search': (p, t) => ({
    name: 'Search Gmail',
    type: 'n8n-nodes-base.gmail', typeVersion: 2.1,
    parameters: {
      resource: 'message', operation: 'getAll',
      limit: Number(p.limit) || 10,
      filters: { q: t(p.query) },
    },
  }),
  'gmail.send': (p, t) => ({
    name: 'Send email',
    type: 'n8n-nodes-base.gmail', typeVersion: 2.1,
    parameters: {
      resource: 'message', operation: 'send',
      sendTo: t(p.to),
      subject: t(p.subject),
      emailType: 'text',
      message: t(p.body),
      options: {},
    },
  }),
  'sheets.read': (p, t) => ({
    name: 'Read sheet',
    type: 'n8n-nodes-base.googleSheets', typeVersion: 4.5,
    parameters: {
      operation: 'read',
      documentId: { __rl: true, mode: 'url', value: t(p.spreadsheetUrl) },
      sheetName: { __rl: true, mode: 'name', value: t(p.sheetName ?? 'Sheet1') },
      options: {},
    },
  }),
  'sheets.append': (p, t) => {
    const columns = renderAll(p.columns, t);
    return {
      name: 'Append to sheet',
      type: 'n8n-nodes-base.googleSheets', typeVersion: 4.5,
      parameters: {
        operation: 'append',
        documentId: { __rl: true, mode: 'url', value: t(p.spreadsheetUrl) },
        sheetName: { __rl: true, mode: 'name', value: t(p.sheetName ?? 'Sheet1') },
        columns: {
          mappingMode: 'defineBelow',
          value: columns,
          matchingColumns: [],
          schema: Object.keys(columns).map((c) => ({
            id: c, displayName: c, required: false, defaultMatch: false,
            display: true, type: 'string', canBeUsedToMatch: true,
          })),
        },
        options: {},
      },
    };
  },
  'http.request': (p, t) => {
    const method = String(p.method || 'GET').toUpperCase();
    const node = {
      name: 'HTTP request',
      type: 'n8n-nodes-base.httpRequest', typeVersion: 4.2,
      parameters: { method, url: t(p.url), options: {} },
    };
    // n8n URL-encodes query values, so the plan does not need a step for that.
    if (isMap(p.query)) Object.assign(node.parameters, { sendQuery: true, queryParameters: pairs(p.query, t) });
    if (isMap(p.headers)) Object.assign(node.parameters, { sendHeaders: true, headerParameters: pairs(p.headers, t) });
    if (p.body !== undefined && method !== 'GET') {
      Object.assign(node.parameters, {
        sendBody: true,
        specifyBody: 'json',
        jsonBody: typeof p.body === 'string' ? t(p.body) : t.json(p.body),
      });
    }
    return node;
  },
  'telegram.send': (p, t) => ({
    name: 'Send Telegram message',
    type: 'n8n-nodes-base.telegram', typeVersion: 1.2,
    parameters: {
      chatId: t(p.chatId),
      text: t(p.text),
      additionalFields: {},
    },
  }),
  transform: (p) => ({
    name: 'Transform data',
    type: 'n8n-nodes-base.code', typeVersion: 2,
    parameters: { jsCode: String(p.jsCode || 'return $input.all();') },
  }),
  browser: () => ({
    name: 'Manual step',
    type: 'n8n-nodes-base.noOp', typeVersion: 1,
    parameters: {},
  }),
};

/**
 * @param planInput  plan from the model (normalized here)
 * @param choices    { variables, trigger } as confirmed by the user in the extension
 */
export function buildWorkflow(planInput, choices = {}) {
  const plan = normalizePlan(planInput);
  const variables = normalizeVariables(choices.variables ?? plan.variables);
  const trigger = normalizeTrigger(choices.trigger ?? plan.trigger);
  const vars = new Map(variables.map((v) => [v.name, v]));

  const nodes = [];
  const chain = [];
  const stepNames = [];
  const used = new Set();
  let x = 0;

  const t = (value) => render(String(value ?? ''), vars, stepNames);
  t.json = (body) => renderJson(body, vars, stepNames);

  const uniqueName = (base) => {
    let name = base.slice(0, 60);
    for (let n = 2; used.has(name); n++) name = `${base.slice(0, 56)} ${n}`;
    used.add(name);
    return name;
  };

  const place = (node, { inChain = true, position } = {}) => {
    node.name = uniqueName(node.name);
    node.id = randomUUID();
    node.position = position || [x, Y];
    if (!position) x += DX;
    nodes.push(node);
    if (inChain) chain.push(node.name);
    return node;
  };

  const notes = [
    `## ${plan.title}`,
    plan.summary,
    '',
    'Generated by **ShowOnce** from a recording.',
    'Connect your accounts (credentials) in each node, then test it.',
  ];
  if (plan.questions.length) notes.push('', '**Please check:**', ...plan.questions.map((q) => `- ${q}`));
  place({
    name: 'About this workflow',
    type: 'n8n-nodes-base.stickyNote', typeVersion: 1,
    parameters: { content: notes.join('\n'), width: 420, height: noteHeight(notes.join('\n')), color: 5 },
  }, { inChain: false, position: [-40, -40] });

  place(triggerNode(trigger, plan.title));
  if (variables.length) place(variablesNode(variables, trigger));

  for (const step of plan.steps) {
    const node = STEP_FACTORIES[step.kind](step.params, t);
    if (step.description) Object.assign(node, { notes: step.description, notesInFlow: true });
    if (step.kind === 'browser') {
      node.name = `Manual: ${step.description || 'browser step'}`.slice(0, 60);
      const p = step.params;
      place({
        name: 'Manual step note',
        type: 'n8n-nodes-base.stickyNote', typeVersion: 1,
        parameters: {
          content: `### ⚠ No API for this step\n${p.instructions || step.description}${p.url ? `\n\nURL: ${p.url}` : ''}\n\nReplace this with an HTTP Request node, a community browser node, or do it by hand.`,
          width: 300, height: 220, color: 3,
        },
      }, { inChain: false, position: [x - 40, Y + 140] });
    }
    stepNames.push(place(node).name);
  }

  const connections = {};
  for (let i = 0; i < chain.length - 1; i++) {
    connections[chain[i]] = { main: [[{ node: chain[i + 1], type: 'main', index: 0 }]] };
  }

  return {
    name: plan.title,
    nodes,
    connections,
    settings: { executionOrder: 'v1' },
  };
}
