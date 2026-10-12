import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:net';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { buildWorkflow, render } from '../src/builder.js';
import { extractJson } from '../src/json.js';
import { normalizePlan } from '../src/plan.js';
import { analyzeTrace, buildParts } from '../src/analyze.js';
import { eventLog } from '../src/prompt.js';
import { server } from '../src/app.js';
import { config } from '../src/config.js';

const plan = JSON.parse(readFileSync(new URL('../examples/sample-plan.json', import.meta.url)));
const recording = JSON.parse(readFileSync(new URL('../examples/sample-recording.json', import.meta.url)));
const mockConfig = { ...config, provider: 'mock', model: 'mock' };

test('extractJson handles fences and prose', () => {
  assert.deepEqual(extractJson('```json\n{"a":1}\n```'), { a: 1 });
  assert.deepEqual(extractJson('Sure! Here it is: {"a":{"b":2}} hope it helps'), { a: { b: 2 } });
  assert.throws(() => extractJson('no json here'));
});

test('render: fixed vars inline, dynamic vars and prev fields become expressions', () => {
  const vars = new Map([
    ['fixed', { name: 'fixed', example: 'abc', dynamic: false }],
    ['dyn', { name: 'dyn', example: 'x', dynamic: true }],
  ]);
  assert.equal(render('q={{var:fixed}}', vars), 'q=abc');
  assert.equal(render('hi {{var:dyn}}', vars), "=hi {{ $('Variables').first().json.dyn }}");
  assert.equal(render('{{prev:valor}}', vars), '={{ $json.valor }}');
  assert.equal(render('{{prev:Valor (R$)}}', vars), '={{ $json["Valor (R$)"] }}');
  assert.equal(render('plain', vars), 'plain');
});

test('render: nested paths and earlier steps', () => {
  const none = new Map();
  assert.equal(render('{{prev:items.0.id.videoId}}', none), '={{ $json.items[0].id.videoId }}');
  assert.equal(render('id={{step:1.snippet.videoId}}', none, ['HTTP request']), "=id={{ $('HTTP request').first().json.snippet.videoId }}");
  assert.equal(render('{{step:3.x}}', none, ['only one']), '{{step:3.x}}', 'unknown steps are left alone');
});

test('http.request: query, headers and a JSON body that stays valid', () => {
  const wf = buildWorkflow({
    title: 'YouTube',
    variables: [
      { name: 'termo', example: 'Ola tudo bem?', dynamic: true },
      { name: 'comentario', example: 'Disse "ola"', dynamic: false },
    ],
    steps: [
      { kind: 'http.request', params: { method: 'GET', url: 'https://www.googleapis.com/youtube/v3/search', query: { part: 'snippet', q: '{{var:termo}}' } } },
      { kind: 'http.request', params: { method: 'POST', url: 'https://www.googleapis.com/youtube/v3/commentThreads', headers: { 'X-Test': '1' }, body: { snippet: { videoId: '{{prev:items.0.id.videoId}}', text: '{{var:comentario}}' } } } },
      { kind: 'http.request', params: { method: 'POST', url: 'https://www.googleapis.com/youtube/v3/videos/rate', query: { id: '{{step:1.items.0.id.videoId}}', rating: 'dislike' } } },
    ],
  });
  const [search, comment, rate] = wf.nodes.filter((n) => n.type === 'n8n-nodes-base.httpRequest');
  assert.equal(search.parameters.sendQuery, true);
  assert.deepEqual(search.parameters.queryParameters.parameters[1], { name: 'q', value: "={{ $('Variables').first().json.termo }}" });
  assert.deepEqual(comment.parameters.headerParameters.parameters, [{ name: 'X-Test', value: '1' }]);
  assert.ok(comment.parameters.jsonBody.startsWith('='));
  // with the expression swapped for a value, the body is valid JSON and the quotes survived
  const resolve = (jsonBody, $json) => JSON.parse(jsonBody.slice(1).replace(/\{\{ (.*?) \}\}/g, (m, expr) => new Function('$json', `return ${expr}`)($json)));
  const body = resolve(comment.parameters.jsonBody, { items: [{ id: { videoId: 'abc' } }] });
  assert.deepEqual(body.snippet, { videoId: 'abc', text: 'Disse "ola"' });
  // a run-time value with quotes or line breaks must not break the body either
  const tricky = 'a "b"\nc';
  assert.equal(resolve(comment.parameters.jsonBody, { items: [{ id: { videoId: tricky } }] }).snippet.videoId, tricky);
  assert.equal(rate.parameters.queryParameters.parameters[0].value, "={{ $('HTTP request').first().json.items[0].id.videoId }}");
});

test('normalizePlan turns unknown step kinds into manual steps', () => {
  const p = normalizePlan({ title: 'x', steps: [{ kind: 'slack.post', description: 'post it' }], variables: [{ name: 'Nome Bonito!' }] });
  assert.equal(p.steps[0].kind, 'browser');
  assert.match(p.steps[0].params.instructions, /slack\.post/);
  assert.equal(p.variables[0].name, 'nome_bonito');
  assert.equal(p.trigger.type, 'manual');
  assert.throws(() => normalizePlan({ steps: [] }));
});

test('buildWorkflow produces a valid linear n8n workflow', () => {
  const wf = buildWorkflow(plan);
  const names = wf.nodes.map((n) => n.name);
  assert.equal(new Set(names).size, names.length, 'node names are unique');
  assert.ok(wf.nodes.every((n) => n.id && n.type && Array.isArray(n.position)));

  const flow = wf.nodes.filter((n) => n.type !== 'n8n-nodes-base.stickyNote');
  assert.deepEqual(flow.map((n) => n.type), [
    'n8n-nodes-base.scheduleTrigger',
    'n8n-nodes-base.set',
    'n8n-nodes-base.gmail',
    'n8n-nodes-base.code',
    'n8n-nodes-base.googleSheets',
    'n8n-nodes-base.telegram',
  ]);
  // every node except the last is connected to the next one
  for (let i = 0; i < flow.length - 1; i++) {
    assert.equal(wf.connections[flow[i].name].main[0][0].node, flow[i + 1].name);
  }
  const gmail = flow[2];
  assert.equal(gmail.parameters.filters.q, 'from:faturas@exemplo.com is:unread subject:fatura');
  const sheets = flow[4];
  assert.equal(sheets.parameters.documentId.value, 'https://docs.google.com/spreadsheets/d/EXEMPLO/edit');
  assert.equal(sheets.parameters.columns.value.Data, '={{ $json.data }}');
  const tg = flow[5];
  assert.equal(tg.parameters.chatId, "={{ $('Variables').first().json.chat_id }}");
  assert.equal(wf.nodes[0].type, 'n8n-nodes-base.stickyNote');
});

test('user choices override the plan (trigger + dynamic flags)', () => {
  const variables = plan.variables.map((v) => ({ ...v, dynamic: v.name === 'remetente' }));
  const wf = buildWorkflow(plan, { variables, trigger: { type: 'webhook' } });
  const hook = wf.nodes.find((n) => n.type === 'n8n-nodes-base.webhook');
  assert.ok(hook && hook.parameters.path);
  const set = wf.nodes.find((n) => n.name === 'Variables');
  const remetente = set.parameters.assignments.assignments.find((a) => a.name === 'remetente');
  assert.equal(remetente.value, '={{ $json.body.remetente ?? "faturas@exemplo.com" }}');
  const gmail = wf.nodes.find((n) => n.type === 'n8n-nodes-base.gmail');
  assert.match(gmail.parameters.filters.q, /^=from:\{\{ \$\('Variables'\)/);
});

test('browser steps become a marked manual node with a note', () => {
  const wf = buildWorkflow({ title: 't', steps: [{ kind: 'browser', description: 'Baixar boleto', params: { url: 'https://banco.example', instructions: 'Clique em Baixar' } }] });
  assert.ok(wf.nodes.find((n) => n.type === 'n8n-nodes-base.noOp' && n.name.startsWith('Manual:')));
  assert.ok(wf.nodes.find((n) => n.type === 'n8n-nodes-base.stickyNote' && n.parameters.content.includes('Clique em Baixar')));
});

test('event log is readable and keeps redactions', () => {
  const log = eventLog(recording.events);
  assert.match(log, /#1 \[on mail\.google\.com\]/);
  assert.match(log, /Copied text: "R\$ 189,90"/);
  assert.match(log, /\[REDACTED\]/);
  assert.doesNotMatch(log, /screenshot/i);
});

test('buildParts samples screenshots evenly', () => {
  const px = 'data:image/jpeg;base64,AAAA';
  const events = Array.from({ length: 50 }, (_, i) => ({ kind: 'click', target: { tag: 'a', label: `l${i}` }, screenshot: px }));
  const parts = buildParts(events, 10);
  assert.equal(parts.filter((p) => p.type === 'image').length, 10);
});

test('analyzeTrace end-to-end with the mock provider', async () => {
  const p = await analyzeTrace(recording, mockConfig);
  assert.equal(p.steps.length, 4);
  await assert.rejects(analyzeTrace({ events: [] }, mockConfig), /empty/);
});

test('HTTP server: health, build, and blocks foreign origins', async () => {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const health = await fetch(`${base}/health`).then((r) => r.json());
    assert.equal(health.ok, true);

    const res = await fetch(`${base}/build`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'chrome-extension://abc' },
      body: JSON.stringify({ plan }),
    });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('access-control-allow-origin'), 'chrome-extension://abc');
    const { workflow } = await res.json();
    assert.equal(workflow.name, plan.title);

    const evil = await fetch(`${base}/build`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'https://evil.example' },
      body: JSON.stringify({ plan }),
    });
    assert.equal(evil.status, 403);

    const deploy = await fetch(`${base}/deploy`, { method: 'POST', body: JSON.stringify({ plan }) });
    // n8n not configured in tests -> clear 400 instead of a crash
    if (!config.n8nApiKey) assert.equal(deploy.status, 400);
  } finally {
    await new Promise((r) => server.close(r));
  }
});

test('n8n connected from the popup: check the key, then create the workflow', async () => {
  const created = [];
  const n8nServer = (await import('node:http')).createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      if (req.headers['x-n8n-api-key'] !== 'good-key') { res.writeHead(401); return res.end('{"message":"unauthorized"}'); }
      if (req.method === 'POST') created.push(JSON.parse(raw));
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(req.method === 'POST' ? '{"id":"wf1"}' : '{"data":[]}');
    });
  });
  await new Promise((r) => n8nServer.listen(0, '127.0.0.1', r));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const url = `http://127.0.0.1:${n8nServer.address().port}/`;
  const call = (path, body) => fetch(`${base}${path}`, { method: 'POST', body: JSON.stringify(body) });
  try {
    const ok = await call('/n8n/check', { n8n: { url, apiKey: 'good-key' } });
    assert.deepEqual(await ok.json(), { ok: true, url: url.slice(0, -1) });

    const bad = await call('/n8n/check', { n8n: { url, apiKey: 'wrong' } });
    assert.equal(bad.status, 502);
    assert.match((await bad.json()).error, /did not accept the API key/);

    const noScheme = await call('/n8n/check', { n8n: { url: 'localhost:5678', apiKey: 'good-key' } });
    assert.equal(noScheme.status, 400);

    const deployed = await call('/deploy', { plan, n8n: { url, apiKey: 'good-key' } }).then((r) => r.json());
    assert.equal(deployed.url, `${url}workflow/wf1`);
    assert.deepEqual(Object.keys(created[0]), ['name', 'nodes', 'connections', 'settings']);
  } finally {
    await new Promise((r) => server.close(r));
    await new Promise((r) => n8nServer.close(r));
  }
});

const json = (body) => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

test('assistant mode: the recording waits until a plan is handed back', async () => {
  const provider = config.provider;
  config.provider = 'mcp';
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    assert.equal((await fetch(`${base}/recording`)).status, 404);

    const px = 'data:image/jpeg;base64,AAAA';
    const events = recording.events.map((e) => ({ ...e, screenshot: px }));
    const sent = await fetch(`${base}/analyze`, json({ events })).then((r) => r.json());
    assert.equal(sent.pending, true);

    const rec = await fetch(`${base}/recording?images=2`).then((r) => r.json());
    assert.match(rec.system, /JSON object/);
    assert.equal(rec.parts.filter((p) => p.type === 'image').length, 2);

    assert.deepEqual(await fetch(`${base}/plan?id=${sent.id}`).then((r) => r.json()), { pending: true });

    const saved = await fetch(`${base}/plan`, json({ plan })).then((r) => r.json());
    assert.equal(saved.delivered, true);
    const got = await fetch(`${base}/plan?id=${sent.id}`).then((r) => r.json());
    assert.equal(got.plan.steps.length, 4);
    // collected once, then gone
    assert.equal((await fetch(`${base}/plan?id=${sent.id}`)).status, 404);
  } finally {
    config.provider = provider;
    await new Promise((r) => server.close(r));
  }
});

test('any chat AI: prompt out, pasted answer in', async () => {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const { prompt } = await fetch(`${base}/prompt`, json(recording)).then((r) => r.json());
    assert.match(prompt, /Step kinds and their params/);
    assert.match(prompt, /Copied text: "R\$ 189,90"/);

    const answer = `Here is your plan:\n\`\`\`json\n${JSON.stringify(plan)}\n\`\`\`\nAnything else?`;
    const res = await fetch(`${base}/plan`, json({ text: answer }));
    assert.equal(res.status, 200);
    assert.equal((await res.json()).plan.title, plan.title);

    assert.equal((await fetch(`${base}/plan`, json({ text: 'sorry, I cannot help' }))).status, 422);
  } finally {
    await new Promise((r) => server.close(r));
  }
});

test('MCP server: an assistant fetches the recording and submits the plan', async () => {
  const port = await new Promise((resolve) => {
    const probe = createServer().listen(0, '127.0.0.1', () => {
      const { port: free } = probe.address();
      probe.close(() => resolve(free));
    });
  });
  const base = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, [fileURLToPath(new URL('../src/mcp.js', import.meta.url))], {
    env: { ...process.env, PORT: String(port), HOST: '127.0.0.1' },
    stdio: ['pipe', 'pipe', 'ignore'],
  });
  const answers = readline.createInterface({ input: child.stdout })[Symbol.asyncIterator]();
  let nextId = 1;
  const rpc = async (method, params) => {
    const id = nextId++;
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    const { value } = await answers.next();
    const msg = JSON.parse(value);
    assert.equal(msg.id, id);
    return msg;
  };

  try {
    const init = await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '0' } });
    assert.equal(init.result.protocolVersion, '2025-06-18');
    assert.equal(init.result.serverInfo.name, 'showonce');
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);

    const { tools } = (await rpc('tools/list')).result;
    assert.deepEqual(tools.map((t) => t.name), ['get_recording', 'submit_plan']);

    const none = (await rpc('tools/call', { name: 'get_recording', arguments: {} })).result;
    assert.equal(none.isError, true);
    assert.match(none.content[0].text, /No recording is waiting/);

    // the extension sends a recording to the server the connector is hosting
    const px = 'data:image/jpeg;base64,AAAA';
    const events = recording.events.map((e) => ({ ...e, screenshot: px }));
    const sent = await fetch(`${base}/analyze`, json({ events })).then((r) => r.json());

    const rec = (await rpc('tools/call', { name: 'get_recording', arguments: { max_screenshots: 3 } })).result;
    assert.ok(!rec.isError);
    assert.equal(rec.content.filter((c) => c.type === 'image' && c.mimeType === 'image/jpeg').length, 3);
    assert.match(rec.content.filter((c) => c.type === 'text').map((c) => c.text).join('\n'), /Copied text: "R\$ 189,90"/);

    const done = (await rpc('tools/call', { name: 'submit_plan', arguments: { plan } })).result;
    assert.match(done.content[0].text, /Plan saved/);
    const got = await fetch(`${base}/plan?id=${sent.id}`).then((r) => r.json());
    assert.equal(got.plan.title, plan.title);

    assert.equal((await rpc('nope')).error.code, -32601);
  } finally {
    child.kill();
  }
});
