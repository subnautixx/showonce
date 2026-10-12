// ShowOnce service worker: keeps the recording, takes screenshots and asks the model for a plan.
import { analyzeTrace } from './core/analyze.js';
import { DEFAULT_MODELS } from './core/providers/index.js';

const DEFAULT_SERVER = 'http://localhost:8787';
const MAX_IMAGES = 20;          // screenshots sent to the model per recording
const MAX_SHOTS = 40;
const SHOT_INTERVAL_MS = 700;   // captureVisibleTab allows ~2 calls/second
const SHOT_DELAY_MS = 350;      // after a click or typing: the page has reacted
const LOADED_DELAY_MS = 500;    // after a page finished loading: it has painted
const SETTLE_DELAY_MS = 1500;   // after an address change with no page load (single-page apps)
const REDIRECT_MS = 1500;       // address changes this close together are one navigation

let queue = Promise.resolve();
let navQueue = Promise.resolve();
let lastShot = 0;
let lastNav = null;             // { id, tabId, url, ts, loaded, touched }: the latest "navigate" (or "start") event
const shotTimers = new Map();   // event id -> its pending screenshot

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

/**
 * Photograph the tab for an event, `delay` ms from now. Asking again for the same event moves its picture
 * to the later moment. `unlessNavigatedSince`: skip it when a page change started after that time, because
 * the picture would show a page on its way out (the navigation gets its own, once loaded).
 */
function shoot(eventId, tab, delay, { unlessNavigatedSince } = {}) {
  if (!tab?.active) return;
  clearTimeout(shotTimers.get(eventId));
  shotTimers.set(eventId, setTimeout(async () => {
    shotTimers.delete(eventId);
    if (unlessNavigatedSince && lastNav && lastNav.ts >= unlessNavigatedSince) return;
    if (Date.now() - lastShot < SHOT_INTERVAL_MS) return;
    try {
      const current = await chrome.tabs.get(tab.id);
      if (!current.active) return;
      const { events = [] } = await chrome.storage.local.get('events');
      const mine = events.find((e) => e.id === eventId);
      if (!mine || (!mine.screenshot && events.filter((e) => e.screenshot).length >= MAX_SHOTS)) return;
      lastShot = Date.now();
      const dataUrl = await chrome.tabs.captureVisibleTab(current.windowId, { format: 'jpeg', quality: 45 });
      await patchEvent(eventId, { screenshot: dataUrl });
    } catch (err) {
      // chrome:// pages, the Web Store, PDFs etc. cannot be captured. That's fine.
    }
  }, delay));
}

/** Stores an event; resolves to its id (null when not recording). */
async function record(event, tab, { screenshot = true } = {}) {
  if (!(await isRecording())) return null;
  const id = crypto.randomUUID();
  await appendEvent({ id, ...event });
  // The user did something on the page: later address changes are new navigations, not redirects.
  if (event.kind !== 'navigate' && event.kind !== 'start' && lastNav) lastNav.touched = true;
  if (screenshot) shoot(id, tab, SHOT_DELAY_MS, { unlessNavigatedSince: event.ts });
  return id;
}

async function setBadge(on) {
  await chrome.action.setBadgeText({ text: on ? 'REC' : '' });
  if (on) await chrome.action.setBadgeBackgroundColor({ color: '#e5484d' });
}

async function startRecording() {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  lastShot = 0;
  lastNav = null;
  await chrome.storage.local.set({ recording: true, events: [], plan: null, analysis: null, startedAt: Date.now() });
  await setBadge(true);
  // Tabs opened before the extension was installed don't have the content script yet.
  if (tab?.id && /^https?:/.test(tab.url || '')) {
    try { await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content.js'] }); } catch {}
  }
  const id = await record({ kind: 'start', url: tab?.url, title: tab?.title, ts: Date.now() }, tab);
  // The starting page counts as already visited (ts 0: nothing gets merged into it as a redirect).
  if (id && tab?.id) lastNav = { id, tabId: tab.id, url: tab.url, ts: 0, loaded: tab.status === 'complete', touched: false };
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

// Assistant mode: the local helper keeps the recording until an AI assistant hands back the plan (the popup polls for it).
async function handToAssistant(events, serverUrl, retried) {
  let res;
  try {
    res = await fetch(`${serverUrl}/analyze`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ events }),
    });
  } catch {
    throw new Error(`Could not reach the ShowOnce helper at ${serverUrl}. It starts with your AI assistant once ShowOnce is added to it (see Set up).`);
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Server error ${res.status}`);
  if (data.pending) return { analysis: { status: 'waiting', id: data.id, retried: !!retried } };
  return { plan: data.plan, analysis: { status: 'done' } };
}

/** `retried`: the popup is handing the recording to the helper a second time (it had lost the first). */
async function analyze(retried) {
  const { events = [], serverUrl = DEFAULT_SERVER, ai } = await chrome.storage.local.get(['events', 'serverUrl', 'ai']);
  if (!events.length) throw new Error('Nothing recorded yet.');
  await chrome.storage.local.set({ analysis: { status: 'running', startedAt: Date.now() } });
  const stop = keepAlive();
  try {
    if (ai?.provider === 'mcp') {
      await chrome.storage.local.set(await handToAssistant(events, serverUrl.replace(/\/+$/, ''), retried));
      return;
    }
    // Every other provider is called straight from here, with the user's own key.
    const plan = await analyzeTrace({ events }, {
      provider: ai?.provider,
      model: ai?.model || DEFAULT_MODELS[ai?.provider],
      maxImages: MAX_IMAGES,
      keys: { [ai?.provider]: ai?.apiKey },
      openaiBaseUrl: ai?.baseUrl || 'https://api.openai.com/v1',
      ollamaUrl: ai?.baseUrl || 'http://localhost:11434',
    });
    await chrome.storage.local.set({ plan, analysis: { status: 'done' } });
  } catch (err) {
    await chrome.storage.local.set({ analysis: { status: 'error', error: err.message } });
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
      analyze(msg.retry).catch(async (e) => chrome.storage.local.set({ analysis: { status: 'error', error: e.message } }));
      sendResponse({ ok: true });
      return false;
    case 'showonce:clear':
      enqueue(() => chrome.storage.local.set({ events: [], plan: null, analysis: null })).then(() => sendResponse({ ok: true }));
      return true;
  }
  return false;
});

// One page change = one "navigate" event, with the final address, the real title and a picture of the loaded page.
async function navigated(tabId, url, tab, loaded) {
  if (!(await isRecording())) return;
  const now = Date.now();
  const last = lastNav?.tabId === tabId ? lastNav : null;
  if (last?.url === url) {
    // The same page again, usually to say it finished loading: now its title and its picture are right.
    if (loaded && !last.loaded) {
      last.loaded = true;
      await patchEvent(last.id, { title: tab.title });
      if (!last.touched) shoot(last.id, tab, LOADED_DELAY_MS);
    }
    return;
  }
  if (last && !last.touched && last.ts && now - last.ts < REDIRECT_MS) {
    // A redirect, or the site rewriting its own address: still that navigation, now with the final address.
    Object.assign(last, { url, ts: now, loaded });
    await patchEvent(last.id, { url, title: tab.title });
    shoot(last.id, tab, loaded ? LOADED_DELAY_MS : SETTLE_DELAY_MS);
    return;
  }
  const id = await record({ kind: 'navigate', url, title: tab.title, ts: now }, tab, { screenshot: false });
  if (!id) return;
  lastNav = { id, tabId, url, ts: now, loaded, touched: false };
  shoot(id, tab, loaded ? LOADED_DELAY_MS : SETTLE_DELAY_MS);
}

// Page navigations (including single-page-app URL changes), in the tab the user is looking at.
chrome.tabs.onUpdated.addListener((tabId, info, tab) => {
  const url = info.url || (info.status === 'complete' ? tab.url : null);
  if (!url || !/^https?:/.test(url) || !tab.active) return;
  // One at a time: two updates about the same page must not both look new.
  navQueue = navQueue
    .then(() => navigated(tabId, url, tab, info.status === 'complete'))
    .catch((err) => console.error('[ShowOnce]', err));
});

chrome.runtime.onStartup.addListener(async () => setBadge(await isRecording()));
