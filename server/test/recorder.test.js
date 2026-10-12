// The extension's service worker, driven with a fake `chrome` (its own file: the worker keeps module state).
import { test } from 'node:test';
import assert from 'node:assert/strict';

const store = {};
const listeners = {};
const tabs = { 1: { id: 1, windowId: 1, active: true, status: 'complete', url: 'https://site.test/home', title: 'Home' } };
let captures = 0;

globalThis.chrome = {
  storage: {
    local: {
      async get(keys) {
        const wanted = keys == null ? Object.keys(store) : [].concat(keys);
        return structuredClone(Object.fromEntries(wanted.filter((k) => k in store).map((k) => [k, store[k]])));
      },
      async set(values) { Object.assign(store, structuredClone(values)); },
    },
  },
  runtime: {
    onMessage: { addListener: (fn) => { listeners.message = fn; } },
    onStartup: { addListener() {} },
    getPlatformInfo() {},
  },
  tabs: {
    onUpdated: { addListener: (fn) => { listeners.updated = fn; } },
    async query() { return [{ ...tabs[1] }]; },
    async get(id) { return { ...tabs[id] }; },
    async captureVisibleTab() { captures++; return 'data:image/jpeg;base64,AAAA'; },
  },
  action: { async setBadgeText() {}, async setBadgeBackgroundColor() {} },
  scripting: { async executeScript() {} },
};

await import('../../extension/background.js');

const settle = async () => { for (let i = 0; i < 25; i++) await new Promise((r) => setImmediate(r)); };
const send = (msg, tab) => new Promise((resolve) => {
  if (listeners.message(msg, { tab }, resolve) !== true) resolve();
});
const update = (info, change = {}) => {
  Object.assign(tabs[1], change);
  listeners.updated(1, info, { ...tabs[1] });
};

test('recorder: one navigate per page change, pictured once the page has loaded', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_000_000 });
  const tick = async (ms) => { t.mock.timers.tick(ms); await settle(); };

  await send({ type: 'showonce:start' });
  await settle();
  await tick(400); // the starting page gets its picture

  const click = { kind: 'click', target: { tag: 'a', label: 'Perfil' }, url: tabs[1].url, ts: Date.now() };
  await send({ type: 'showonce:event', event: click }, { ...tabs[1] });
  await settle();
  await tick(100);
  update({ status: 'loading', url: 'https://site.test/users/profile' },
    { status: 'loading', url: 'https://site.test/users/profile', title: 'site.test/users/profile' });
  await settle();
  await tick(200);
  update({ url: 'https://site.test/users/42/profile' }, { url: 'https://site.test/users/42/profile' }); // a redirect
  await settle();
  await tick(300); // the click's own picture would have been taken here, of a page on its way out
  update({ status: 'complete' }, { status: 'complete', title: 'Ana - Site' });
  update({ status: 'complete' }); // browsers say it more than once
  await settle();
  await tick(600);

  let { events } = store;
  assert.deepEqual(events.map((e) => e.kind), ['start', 'click', 'navigate']);
  const [start, clicked, nav] = events;
  assert.equal(nav.url, 'https://site.test/users/42/profile', 'the redirect did not become a second event');
  assert.equal(nav.title, 'Ana - Site', 'the title is the loaded page’s, not the address');
  assert.ok(start.screenshot && nav.screenshot);
  assert.equal(clicked.screenshot, undefined);
  assert.equal(captures, 2);

  // a background tab doing its own thing is not something the user did
  listeners.updated(2, { status: 'complete' }, { id: 2, windowId: 1, active: false, url: 'https://other.test/', title: 'Other' });
  await settle();
  assert.equal(store.events.length, 3);

  // a single-page app changes the address without loading: still recorded, pictured after it settles
  await tick(3000);
  update({ url: 'https://site.test/games/7#servers' }, { url: 'https://site.test/games/7#servers', title: 'Game' });
  await settle();
  await tick(1600);
  ({ events } = store);
  assert.equal(events.length, 4);
  assert.equal(events[3].url, 'https://site.test/games/7#servers');
  assert.ok(events[3].screenshot);
});
