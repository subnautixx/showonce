// Everything runs inside the extension. Only the MCP assistant mode talks to the local helper (server/).
import { planFromText, traceEvents } from './core/analyze.js';
import { buildWorkflow } from './core/builder.js';
import { checkN8n, deployWorkflow, n8nReachable } from './core/n8n.js';
import { chatPrompt as promptFor } from './core/prompt.js';
import { DEFAULT_MODELS } from './core/providers/index.js';

const DEFAULT_SERVER = 'http://localhost:8787';
const DEFAULT_N8N = 'http://localhost:5678';
const MCP_COMMAND = 'npx -y github:subnautixx/showonce mcp';
const DOCKER_COMMAND = 'docker run -d --name n8n -p 5678:5678 -v n8n_data:/home/node/.n8n docker.n8n.io/n8nio/n8n';
const $ = (id) => document.getElementById(id);

const TRIGGER_HINTS = {
  manual: '',
  schedule: 'Cron, e.g. 0 9 * * 1-5 (weekdays 9:00)',
  webhook: '',
  gmail: 'Gmail search, e.g. from:billing@acme.com',
};

const KIND_LABELS = {
  'gmail.search': 'Gmail',
  'gmail.send': 'Gmail',
  'sheets.read': 'Sheets',
  'sheets.append': 'Sheets',
  'http.request': 'HTTP',
  'telegram.send': 'Telegram',
  transform: 'Code',
  browser: 'Manual',
};

// What each way of reading the recording needs from the user.
const AI = {
  chat: { hint: 'Nothing to install. You copy a prompt into ChatGPT, Claude, Gemini… and paste the answer back. Screenshots are not sent, so it suits simpler tasks.' },
  claude: { key: 'https://console.anthropic.com/settings/keys', hint: 'Best results. The key stays in this browser and is only sent to Anthropic.' },
  gemini: { key: 'https://aistudio.google.com/apikey', hint: 'Good and usually cheaper. The key stays in this browser and is only sent to Google.' },
  openai: { key: 'https://platform.openai.com/api-keys', base: 'https://api.openai.com/v1', hint: 'Works with any OpenAI-compatible API: change the address below.' },
  ollama: { base: 'http://localhost:11434', hint: 'Free and offline. Start Ollama with OLLAMA_ORIGINS=chrome-extension://* so it accepts this extension.' },
  mcp: { server: true, copy: MCP_COMMAND, hint: `Claude Code, Claude Desktop, Cursor… reads the recording, screenshots included. Add ShowOnce to it once with this command (needs Node.js): ${MCP_COMMAND}` },
};

let currentPlan = null;
let planPoll = null;

function el(tag, props = {}, children = []) {
  const node = Object.assign(document.createElement(tag), props);
  for (const c of [].concat(children)) node.append(c);
  return node;
}

function setMsg(id, text, kind = '') {
  const m = $(id);
  m.className = `msg ${kind}`;
  m.textContent = text;
}

async function serverUrl() {
  const { serverUrl } = await chrome.storage.local.get('serverUrl');
  return (serverUrl || DEFAULT_SERVER).replace(/\/+$/, '');
}

function saveFile(name, text, type) {
  const a = el('a', { href: URL.createObjectURL(new Blob([text], { type })), download: name });
  a.click();
}

function openBox(id) {
  $(id).open = true;
  $(id).scrollIntoView({ behavior: 'smooth' });
}

// Assistant mode: the plan arrives whenever the assistant submits it, possibly while this popup was closed.
async function checkForPlan(id) {
  try {
    const res = await fetch(`${await serverUrl()}/plan?id=${encodeURIComponent(id)}`);
    const data = await res.json().catch(() => ({}));
    if (data.plan) await chrome.storage.local.set({ plan: data.plan, analysis: { status: 'done' } });
    else if (!res.ok) await chrome.storage.local.set({ analysis: { status: 'error', error: data.error || `Server error ${res.status}` } });
  } catch { /* helper not reachable right now: keep waiting */ }
}

// ---------- set up ----------
function showAi(ai) {
  const provider = ai?.provider || '';
  const need = AI[provider] || {};
  $('aiProvider').value = provider;
  $('aiKeyRow').hidden = !need.key;
  $('aiKey').value = ai?.apiKey || '';
  $('aiBase').hidden = !need.base;
  $('aiBase').placeholder = need.base || '';
  $('aiBase').value = ai?.baseUrl || '';
  $('aiModel').hidden = !DEFAULT_MODELS[provider];
  $('aiModel').placeholder = `Model (default: ${DEFAULT_MODELS[provider] || ''})`;
  $('aiModel').value = ai?.model || '';
  $('serverRow').hidden = !need.server;
  $('aiCopyBtn').hidden = !need.copy;
  $('aiHint').textContent = need.hint || 'Pick how ShowOnce should understand what you recorded. You can change it any time.';
}

const aiReady = (ai) => !!ai?.provider && (!AI[ai.provider]?.key || !!ai.apiKey);

async function refreshSetup() {
  const { ai = null, n8n = null } = await chrome.storage.local.get(['ai', 'n8n']);
  const ready = aiReady(ai);
  $('setupState').className = ready ? 'ok' : 'muted';
  $('setupState').textContent = ready ? `AI ✓ · n8n ${n8n ? '✓' : 'optional'}` : 'start here';
  $('chatBox').hidden = !!ai?.provider && ai.provider !== 'chat';
  return { ai, n8n, ready };
}

async function saveAi() {
  const provider = $('aiProvider').value;
  const ai = provider ? {
    provider,
    apiKey: AI[provider].key ? $('aiKey').value.trim() : '',
    baseUrl: AI[provider].base ? $('aiBase').value.trim().replace(/\/+$/, '') : '',
    model: $('aiModel').value.trim(),
  } : null;
  await chrome.storage.local.set({ ai });
  setMsg('aiMsg', aiReady(ai) ? 'Saved.' : AI[provider]?.key ? 'Paste your API key to finish.' : '', aiReady(ai) ? 'ok' : '');
  await refreshSetup();
  await refreshStatus();
}

$('aiProvider').addEventListener('change', async () => {
  const { ai } = await chrome.storage.local.get('ai');
  // Switching provider must not carry another provider's key or model along.
  showAi({ provider: $('aiProvider').value, ...(ai?.provider === $('aiProvider').value ? ai : {}) });
  await saveAi();
});
for (const id of ['aiKey', 'aiBase', 'aiModel']) $(id).addEventListener('change', saveAi);

$('aiKeyBtn').addEventListener('click', () => chrome.tabs.create({ url: AI[$('aiProvider').value].key }));
$('aiCopyBtn').addEventListener('click', async () => {
  await navigator.clipboard.writeText(AI[$('aiProvider').value].copy);
  setMsg('aiMsg', 'Copied.', 'ok');
});
$('serverUrl').addEventListener('change', (e) =>
  chrome.storage.local.set({ serverUrl: e.target.value.trim() || DEFAULT_SERVER }));

// "localhost:5678" or "my.app.n8n.cloud/" -> a full address
function n8nAddress(value) {
  const v = value.trim().replace(/\/+$/, '') || DEFAULT_N8N;
  if (/^https?:\/\//i.test(v)) return v;
  return `${/^(localhost|127\.|\[::1\])/i.test(v) ? 'http' : 'https'}://${v}`;
}

function showN8n(n8n) {
  $('n8nUrl').value = n8n?.url || '';
  $('n8nKey').value = n8n?.apiKey || '';
  $('n8nState').className = n8n ? 'ok' : '';
  $('n8nState').textContent = n8n ? `✓ ${new URL(n8n.url).host}` : '';
  $('n8nForgetBtn').hidden = !n8n;
}

/** False (and help on screen) when nothing answers at that address. */
async function n8nThere(url) {
  const there = await n8nReachable(url);
  $('n8nHelp').hidden = there;
  if (!there) setMsg('n8nMsg', `No n8n is answering at ${url}.`, 'err');
  return there;
}

$('n8nConnectBtn').addEventListener('click', async () => {
  const n8n = { url: n8nAddress($('n8nUrl').value), apiKey: $('n8nKey').value.trim() };
  $('n8nUrl').value = n8n.url;
  setMsg('n8nMsg', 'Checking…');
  if (!(await n8nThere(n8n.url))) return;
  if (!n8n.apiKey) return setMsg('n8nMsg', 'n8n is there. Now paste an API key: “Get an API key” opens the right page.', 'err');
  try {
    await checkN8n(n8n);
    await chrome.storage.local.set({ n8n });
    showN8n(n8n);
    setMsg('n8nMsg', 'Connected. “Create in n8n” is ready.', 'ok');
    await refreshSetup();
  } catch (err) {
    setMsg('n8nMsg', err.message, 'err');
  }
});

$('n8nKeyBtn').addEventListener('click', async () => {
  const url = n8nAddress($('n8nUrl').value);
  $('n8nUrl').value = url;
  setMsg('n8nMsg', 'Checking…');
  if (!(await n8nThere(url))) return;
  setMsg('n8nMsg', '');
  chrome.tabs.create({ url: `${url}/settings/api` });
});

$('n8nForgetBtn').addEventListener('click', async () => {
  await chrome.storage.local.remove('n8n');
  showN8n(null);
  setMsg('n8nMsg', 'Disconnected. The key was removed from this browser.');
  await refreshSetup();
});

$('n8nCloudBtn').addEventListener('click', () => chrome.tabs.create({ url: 'https://n8n.io/' }));
$('n8nDockerBtn').addEventListener('click', async () => {
  await navigator.clipboard.writeText(DOCKER_COMMAND);
  setMsg('n8nMsg', 'Copied. Run it in a terminal (needs Docker), then open http://localhost:5678 once to create your n8n account.', 'ok');
});

// ---------- recording status ----------
async function refreshStatus() {
  const { recording = false, events = [], analysis = null, ai = null } =
    await chrome.storage.local.get(['recording', 'events', 'analysis', 'ai']);
  $('dot').className = recording ? 'dot on' : 'dot';
  $('statusText').textContent = recording ? 'Recording…' : events.length ? 'Recording ready' : 'Idle';
  $('count').textContent = events.length ? `${events.length} action${events.length === 1 ? '' : 's'}` : '';
  $('startBtn').disabled = recording;
  $('stopBtn').disabled = !recording;
  $('clearBtn').disabled = recording || !events.length;
  const running = analysis?.status === 'running';
  $('analyzeBtn').disabled = recording || !events.length || running;
  $('analyzeBtn').textContent = running ? 'Thinking… (keep this open or come back)' : '✨ Turn it into a workflow';
  $('copyPromptBtn').disabled = $('savePromptBtn').disabled = recording || !events.length;
  const waiting = analysis?.status === 'waiting';
  clearInterval(planPoll);
  if (waiting) {
    planPoll = setInterval(() => checkForPlan(analysis.id), 2000);
    checkForPlan(analysis.id);
  }
  if (analysis?.status === 'error') setMsg('msg', analysis.error, 'err');
  else if (running) setMsg('msg', 'The model is watching your recording. This usually takes 15–60 s.');
  else if (waiting) setMsg('msg', 'Recording sent. Now ask your AI assistant (connected to ShowOnce over MCP): “turn my ShowOnce recording into a workflow”. The plan will show up here.');
  else if (ai?.provider === 'chat' && events.length && !recording) setMsg('msg', 'Copy the prompt below into any AI chat, then paste its answer.');
  else setMsg('msg', '');
}

// ---------- plan review ----------
function renderPlan(plan) {
  currentPlan = plan;
  const review = $('review');
  if (!plan) { review.hidden = true; return; }
  review.hidden = false;
  $('planTitle').textContent = plan.title;
  $('planSummary').textContent = plan.summary || '';

  const steps = $('steps');
  steps.replaceChildren();
  for (const s of plan.steps) {
    const li = el('li', { className: s.kind === 'browser' ? 'warn' : '' }, [
      el('span', { textContent: s.description || s.kind }),
      ' ',
      el('code', { textContent: KIND_LABELS[s.kind] || s.kind }),
    ]);
    if (s.kind === 'browser') li.title = 'No API for this step: it becomes a manual step in n8n.';
    steps.append(li);
  }

  const qs = $('questions');
  qs.replaceChildren(...(plan.questions || []).map((q) => el('div', { className: 'question', textContent: `? ${q}` })));

  const vars = $('vars');
  vars.replaceChildren();
  if (!plan.variables.length) vars.append(el('p', { className: 'hint', textContent: 'No values to configure.' }));
  plan.variables.forEach((v, i) => {
    const checkbox = el('input', { type: 'checkbox', checked: !!v.dynamic, id: `dyn-${i}` });
    vars.append(el('div', { className: 'var' }, [
      el('span', { className: 'name', textContent: v.name }),
      el('label', { className: 'dyn', htmlFor: `dyn-${i}` }, [checkbox, 'changes each run']),
      el('span', { className: 'desc', textContent: v.description || '' }),
      el('input', { type: 'text', value: v.example ?? '', id: `val-${i}` }),
    ]));
  });

  $('trigger').value = plan.trigger?.type || 'manual';
  $('triggerArg').value = plan.trigger?.cron || plan.trigger?.gmailQuery || '';
  updateTriggerArg();
}

function updateTriggerArg() {
  const type = $('trigger').value;
  const arg = $('triggerArg');
  arg.hidden = !TRIGGER_HINTS[type];
  arg.placeholder = TRIGGER_HINTS[type];
  if (type === 'schedule' && !arg.value) arg.value = '0 9 * * 1-5';
}

/** The plan plus what the user ticked and typed, as an n8n workflow. */
function currentWorkflow() {
  const variables = currentPlan.variables.map((v, i) => ({
    ...v,
    example: $(`val-${i}`).value,
    dynamic: $(`dyn-${i}`).checked,
  }));
  const type = $('trigger').value;
  const arg = $('triggerArg').value.trim();
  const trigger = { type };
  if (type === 'schedule') trigger.cron = arg || '0 9 * * 1-5';
  if (type === 'gmail') trigger.gmailQuery = arg;
  return buildWorkflow(currentPlan, { variables, trigger });
}

// ---------- actions ----------
$('startBtn').addEventListener('click', async () => {
  await chrome.runtime.sendMessage({ type: 'showonce:start' });
  renderPlan(null);
  window.close(); // get out of the way so the user can work
});

$('stopBtn').addEventListener('click', () => chrome.runtime.sendMessage({ type: 'showonce:stop' }));
$('clearBtn').addEventListener('click', () => chrome.runtime.sendMessage({ type: 'showonce:clear' }));
$('trigger').addEventListener('change', updateTriggerArg);

$('analyzeBtn').addEventListener('click', async () => {
  const { ai, ready } = await refreshSetup();
  if (!ready) {
    openBox('setup');
    return setMsg('aiMsg', ai?.provider ? 'Paste your API key to finish.' : 'First pick the AI that reads your recording.', 'err');
  }
  if (ai.provider === 'chat') return openBox('chatBox');
  chrome.runtime.sendMessage({ type: 'showonce:analyze' });
});

$('deployBtn').addEventListener('click', async () => {
  const { n8n } = await chrome.storage.local.get('n8n');
  if (!n8n) {
    openBox('setup');
    return setMsg('deployMsg', 'Connect your n8n first (Set up, step 2), or use “Download JSON”.', 'err');
  }
  setMsg('deployMsg', 'Creating workflow in n8n…');
  try {
    const { url } = await deployWorkflow(currentWorkflow(), n8n);
    const link = el('a', { href: url, textContent: 'Open in n8n →' });
    link.addEventListener('click', (e) => { e.preventDefault(); chrome.tabs.create({ url }); });
    const m = $('deployMsg');
    m.className = 'msg ok';
    m.replaceChildren('Done! ', link);
  } catch (err) {
    setMsg('deployMsg', err.message, 'err');
  }
});

$('downloadBtn').addEventListener('click', () => {
  try {
    const workflow = currentWorkflow();
    const name = `${(workflow.name || 'workflow').replace(/[^\w-]+/g, '-').toLowerCase()}.json`;
    saveFile(name, JSON.stringify(workflow, null, 2), 'application/json');
    setMsg('deployMsg', 'Saved. In n8n: Workflows → Import from file.', 'ok');
  } catch (err) {
    setMsg('deployMsg', err.message, 'err');
  }
});

// ---------- any chat AI (no API key) ----------
async function chatPrompt() {
  const { events = [] } = await chrome.storage.local.get('events');
  // Screenshots stay in the browser: a chat AI gets the action log only.
  return promptFor(traceEvents({ events: events.map(({ screenshot, ...ev }) => ev) }));
}

$('copyPromptBtn').addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(await chatPrompt());
    setMsg('chatMsg', 'Copied. Paste it into any AI chat, then paste its answer here.', 'ok');
  } catch (err) {
    setMsg('chatMsg', err.message, 'err');
  }
});

$('savePromptBtn').addEventListener('click', async () => {
  try {
    saveFile('showonce-recording.md', await chatPrompt(), 'text/markdown');
    setMsg('chatMsg', 'Saved. Send the file to any AI chat, then paste its answer here.', 'ok');
  } catch (err) {
    setMsg('chatMsg', err.message, 'err');
  }
});

$('usePlanBtn').addEventListener('click', async () => {
  try {
    const plan = planFromText($('planText').value);
    await chrome.storage.local.set({ plan, analysis: { status: 'done' } });
    $('planText').value = '';
    setMsg('chatMsg', '');
  } catch (err) {
    setMsg('chatMsg', err.message, 'err');
  }
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (changes.recording || changes.events || changes.analysis) refreshStatus();
  if (changes.plan) renderPlan(changes.plan.newValue);
});

(async () => {
  const { plan = null, serverUrl: s } = await chrome.storage.local.get(['plan', 'serverUrl']);
  $('serverUrl').value = s || DEFAULT_SERVER;
  const { ai, n8n, ready } = await refreshSetup();
  showAi(ai);
  showN8n(n8n);
  $('setup').open = !ready; // first run: start with the checklist
  await refreshStatus();
  renderPlan(plan);
})();
