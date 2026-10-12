const DEFAULT_SERVER = 'http://localhost:8787';
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

async function post(path, body) {
  const res = await fetch(`${await serverUrl()}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Server error ${res.status}`);
  return data;
}

function saveFile(name, text, type) {
  const a = el('a', { href: URL.createObjectURL(new Blob([text], { type })), download: name });
  a.click();
}

// Assistant mode: the plan arrives whenever the assistant submits it, possibly while this popup was closed.
async function checkForPlan(id) {
  try {
    const res = await fetch(`${await serverUrl()}/plan?id=${encodeURIComponent(id)}`);
    const data = await res.json().catch(() => ({}));
    if (data.plan) await chrome.storage.local.set({ plan: data.plan, analysis: { status: 'done' } });
    else if (!res.ok) await chrome.storage.local.set({ analysis: { status: 'error', error: data.error || `Server error ${res.status}` } });
  } catch { /* server not reachable right now: keep waiting */ }
}

// ---------- recording status ----------
async function refreshStatus() {
  const { recording = false, events = [], analysis = null } =
    await chrome.storage.local.get(['recording', 'events', 'analysis']);
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

function collectChoices() {
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
  return { plan: currentPlan, variables, trigger };
}

// ---------- actions ----------
$('startBtn').addEventListener('click', async () => {
  await chrome.runtime.sendMessage({ type: 'showonce:start' });
  renderPlan(null);
  window.close(); // get out of the way so the user can work
});

$('stopBtn').addEventListener('click', () => chrome.runtime.sendMessage({ type: 'showonce:stop' }));
$('clearBtn').addEventListener('click', () => chrome.runtime.sendMessage({ type: 'showonce:clear' }));
$('analyzeBtn').addEventListener('click', () => chrome.runtime.sendMessage({ type: 'showonce:analyze' }));
$('trigger').addEventListener('change', updateTriggerArg);

$('deployBtn').addEventListener('click', async () => {
  setMsg('deployMsg', 'Creating workflow in n8n…');
  try {
    const { url } = await post('/deploy', collectChoices());
    const link = el('a', { href: url, textContent: 'Open in n8n →' });
    link.addEventListener('click', (e) => { e.preventDefault(); chrome.tabs.create({ url }); });
    const m = $('deployMsg');
    m.className = 'msg ok';
    m.replaceChildren('Done! ', link);
  } catch (err) {
    setMsg('deployMsg', err.message, 'err');
  }
});

$('downloadBtn').addEventListener('click', async () => {
  try {
    const { workflow } = await post('/build', collectChoices());
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
  const { prompt } = await post('/prompt', { events: events.map(({ screenshot, ...ev }) => ev) });
  return prompt;
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
    const { plan } = await post('/plan', { text: $('planText').value });
    await chrome.storage.local.set({ plan, analysis: { status: 'done' } });
    $('planText').value = '';
    setMsg('chatMsg', '');
  } catch (err) {
    setMsg('chatMsg', err.message, 'err');
  }
});

$('serverUrl').addEventListener('change', (e) =>
  chrome.storage.local.set({ serverUrl: e.target.value.trim() || DEFAULT_SERVER }));

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (changes.recording || changes.events || changes.analysis) refreshStatus();
  if (changes.plan) renderPlan(changes.plan.newValue);
});

(async () => {
  const { plan = null, serverUrl: s } = await chrome.storage.local.get(['plan', 'serverUrl']);
  $('serverUrl').value = s || DEFAULT_SERVER;
  await refreshStatus();
  renderPlan(plan);
})();
