// ShowOnce service worker: keeps the recording, takes screenshots and talks to the local server.
const DEFAULT_SERVER = 'http://localhost:8787';
const MAX_SHOTS = 40;
const SHOT_INTERVAL_MS = 700;   // captureVisibleTab allows ~2 calls/second
const SHOT_DELAY_MS = 350;      // capture the page *after* the action took effect

let queue = Promise.resolve();
let lastShot = 0;
let lastNavUrl = '';

// Serialize storage writes so concurrent events never overwrite each other.
function enqueue(fn) {
  queue = queue.then(fn).catch((err) => console.error('[ShowOnce]', err));
  return queue;
}

async function isRecording() {
  const { recording } = await chrome.storage.local.get('recording');
  return !!recording;
}

function appendEvent(event) {
  return enqueue(async () => {
    const { events = [] } = await chrome.storage.local.get('events');
    events.push(event);
    await chrome.storage.local.set({ events });
  });
}

function patchEvent(id, patch) {
  return enqueue(async () => {
    const { events = [] } = await chrome.storage.local.get('events');
    const ev = events.find((e) => e.id === id);
    if (!ev) return;
    Object.assign(ev, patch);
    await chrome.storage.local.set({ events });
  });
}

async function maybeScreenshot(eventId, tab) {
  if (!tab || !tab.active) return;
  const now = Date.now();
  if (now - lastShot < SHOT_INTERVAL_MS) return;
  const { events = [] } = await chrome.storage.local.get('events');
  if (events.filter((e) => e.screenshot).length >= MAX_SHOTS) return;
  lastShot = now;
  setTimeout(async () => {
    try {
      const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'jpeg', quality: 45 });
      await patchEvent(eventId, { screenshot: dataUrl });
    } catch (err) {
      // chrome:// pages, the Web Store, PDFs etc. cannot be captured. That's fine.
    }
  }, SHOT_DELAY_MS);
}

async function record(event, tab, { screenshot = true } = {}) {
  if (!(await isRecording())) return;
  const id = crypto.randomUUID();
  await appendEvent({ id, ...event });
  if (screenshot) await maybeScreenshot(id, tab);
}

async function setBadge(on) {
  await chrome.action.setBadgeText({ text: on ? 'REC' : '' });
  if (on) await chrome.action.setBadgeBackgroundColor({ color: '#e5484d' });
}

async function startRecording() {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  lastShot = 0;
  lastNavUrl = tab?.url || '';
  await chrome.storage.local.set({ recording: true, events: [], plan: null, analysis: null, startedAt: Date.now() });
  await setBadge(true);
  // Tabs opened before the extension was installed don't have the content script yet.
  if (tab?.id && /^https?:/.test(tab.url || '')) {
    try { await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content.js'] }); } catch {}
  }
  await record({ kind: 'start', url: tab?.url, title: tab?.title, ts: Date.now() }, tab);
}

async function stopRecording() {
  await chrome.storage.local.set({ recording: false });
  await setBadge(false);
  await queue;
}

// Long LLM calls can outlive the service worker's idle timer; keep it awake meanwhile.
function keepAlive() {
  const t = setInterval(() => chrome.runtime.getPlatformInfo(() => {}), 20_000);
  return () => clearInterval(t);
}

async function analyze() {
  const { events = [], serverUrl = DEFAULT_SERVER } = await chrome.storage.local.get(['events', 'serverUrl']);
  if (!events.length) throw new Error('Nothing recorded yet.');
  await chrome.storage.local.set({ analysis: { status: 'running', startedAt: Date.now() } });
  const stop = keepAlive();
  try {
    const res = await fetch(`${serverUrl}/analyze`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ events }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `Server error ${res.status}`);
    // Assistant mode: the server keeps the recording until an AI assistant hands back the plan (the popup polls for it).
    if (data.pending) await chrome.storage.local.set({ analysis: { status: 'waiting', id: data.id } });
    else await chrome.storage.local.set({ plan: data.plan, analysis: { status: 'done' } });
  } catch (err) {
    const msg = err instanceof TypeError
      ? `Could not reach the ShowOnce server at ${serverUrl}. Is it running? (npm start in /server)`
      : err.message;
    await chrome.storage.local.set({ analysis: { status: 'error', error: msg } });
  } finally {
    stop();
  }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  switch (msg?.type) {
    case 'showonce:event':
      record(msg.event, sender.tab);
      return false;
    case 'showonce:start':
      startRecording().then(() => sendResponse({ ok: true }), (e) => sendResponse({ ok: false, error: e.message }));
      return true;
    case 'showonce:stop':
      stopRecording().then(() => sendResponse({ ok: true }));
      return true;
    case 'showonce:analyze':
      analyze().catch(async (e) => chrome.storage.local.set({ analysis: { status: 'error', error: e.message } }));
      sendResponse({ ok: true });
      return false;
    case 'showonce:clear':
      enqueue(() => chrome.storage.local.set({ events: [], plan: null, analysis: null })).then(() => sendResponse({ ok: true }));
      return true;
  }
  return false;
});

// Page navigations (including single-page-app URL changes).
chrome.tabs.onUpdated.addListener(async (tabId, info, tab) => {
  const url = info.url || (info.status === 'complete' ? tab.url : null);
  if (!url || !/^https?:/.test(url) || url === lastNavUrl) return;
  if (!(await isRecording())) return;
  lastNavUrl = url;
  await record({ kind: 'navigate', url, title: tab.title, ts: Date.now() }, tab);
});

chrome.runtime.onStartup.addListener(async () => setBadge(await isRecording()));
