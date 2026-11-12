import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { pathToFileURL } from 'node:url';
import YAML from './vendor/yaml/dist/index.js';
import { configureProfile, configureCredentials, preflight, applyTransaction, rollback } from './install.mjs';
import { createBridge, createFetchRoute, publicStatus, bindingApplies, synchronizeProviderModels, name as modelPluginName } from './plugins/dsh-model-switcher/index.mjs';
import { validateGatewayURL, loadGatewayConfig, validateClientConfig } from './plugins/dsh-model-switcher/settings.mjs';
import { MODELS, MODEL_IDS, hostCredentialRef, hostProvider, validateModels, validateCatalog } from './plugins/dsh-model-switcher/catalog.mjs';

const yamlOptions = { customTags: [{ tag: 'tag:yaml.org,2002:js', resolve: value => value }] };
const host = { id: 'pc', label: 'Windows model host', url: 'http://192.168.50.10:8083', provider: hostProvider('pc'),
  credentialRef: hostCredentialRef('pc'), gatewayId: '11111111-1111-4111-8111-111111111111' };
const second = { id: 'studio', label: 'Second server', url: 'http://192.168.50.11:8083', provider: hostProvider('studio'),
  credentialRef: hostCredentialRef('studio'), gatewayId: '22222222-2222-4222-8222-222222222222' };
const pluginPath = path.join(os.tmpdir(), 'Mac user with spaces', '.dsh/plugins/dsh-model-switcher');
const source = `# retain this comment\n- id: llm-pi-ai\n  config:\n    providers:\n      local-mlx:\n        baseURL: http://127.0.0.1:8080/v1\n        models: [{id: my-local-model}]\n      cloud:\n        apiKeyEnv: CLOUD_KEY\n- id: agent-default-model\n  config: {provider: local-mlx, model: my-local-model}\n- id: another-plugin\n  config:\n    callback: !!js () => 42\n`;
const catalog = { gateway: 'local-model-switch', version: 2, gatewayId: host.gatewayId, hostLabel: host.label, models: MODELS };
const stateFor = (model, which = host, extra = {}) => ({ gateway: 'local-model-switch', version: 2,
  gatewayId: which.gatewayId, phase: 'ready', loadedModel: model, activeModel: model, backendReady: true, ready: true,
  catalogReady: true, models: MODELS, ...extra });
const ok = value => ({ ok: true, json: async () => value });

test('profile edits preserve Mac providers, defaults, JS tags and comments; provider is pinned', () => {
  const before = YAML.parse(source, yamlOptions);
  const result = configureProfile(source, { host, pluginPath }), after = YAML.parse(result.output, yamlOptions);
  assert.deepEqual(after[0].config.providers['local-mlx'], before[0].config.providers['local-mlx']);
  assert.deepEqual(after[0].config.providers.cloud, before[0].config.providers.cloud);
  assert.deepEqual(after[1], before[1]); assert.deepEqual(after[2], before[2]);
  assert.match(result.output, /retain this comment/); assert.match(result.output, /!!js/);
  const added = after[0].config.providers[host.provider];
  assert.equal(added.models.length, 4); assert.equal(added.apiKeyEnv, host.credentialRef);
  assert.equal(added.baseURL, host.url + '/v1'); assert.equal(added.headers['x-local-model-gateway-id'], host.gatewayId);
  assert.match(after.at(-1).insert[0].name, /%20/);
  assert.equal(configureProfile(result.output, { host, pluginPath }).changed, false);
});

test('adding a second host preserves the first host and selected default', () => {
  const first = configureProfile(source, { host, pluginPath }).output;
  const result = configureProfile(first, { host: second, pluginPath }).output;
  const a = YAML.parse(first, yamlOptions), b = YAML.parse(result, yamlOptions);
  assert.deepEqual(b[0].config.providers[host.provider], a[0].config.providers[host.provider]);
  assert.equal(b[0].config.providers[second.provider].baseURL, second.url + '/v1');
  assert.deepEqual(b[1], a[1]); assert.equal(b.filter(row => row.insert).length, 1);
});

test('empty profile adds provider and plugin but never changes the default', () => {
  const result = YAML.parse(configureProfile('[]\n', { host, pluginPath }).output, yamlOptions);
  assert.equal(result.length, 2); assert.equal(result.some(row => row.id === 'agent-default-model'), false);
});

test('foreign provider ownership fails rather than overwriting it', () => {
  assert.throws(() => configureProfile('- id: llm-pi-ai\n  config:\n    providers:\n      windows-pc: {apiKeyEnv: OTHER_KEY}\n', { host, pluginPath }), /another configuration/);
  assert.throws(() => configureProfile('- id: llm-pi-ai\n- id: llm-pi-ai\n', { host, pluginPath }), /Multiple provider/);
});

test('credentials preserve other hosts, unrelated refs and records', () => {
  const prior = 'version: 1\nrefs:\n  OTHER_KEY: original-secret\nrecords:\n  provider-key:\n    type: api-key\n    key: existing-value\n';
  const result = configureCredentials(prior, 'fixture-key', host.credentialRef);
  const before = YAML.parse(prior), after = YAML.parse(configureCredentials(result.output, 'second-fixture', second.credentialRef).output);
  assert.equal(after.refs.OTHER_KEY, before.refs.OTHER_KEY); assert.deepEqual(after.records, before.records);
  assert.equal(after.refs[host.credentialRef], 'fixture-key'); assert.equal(after.refs[second.credentialRef], 'second-fixture');
  assert.equal(configureCredentials(result.output, 'fixture-key', host.credentialRef).changed, false);
  assert.throws(() => configureCredentials('OTHER_KEY: secret\n', 'fixture-key', host.credentialRef), /version 1/);
  assert.throws(() => configureCredentials('', 'bad\nkey', host.credentialRef), /invalid/);
});

test('URL and host config validation reject unsafe/ambiguous endpoints and duplicate hosts', () => {
  for (const value of ['http://user:secret@192.168.50.10:8083', host.url + '/v1', 'http://example.com:8083', host.url + '?key=test']) assert.throws(() => validateGatewayURL(value));
  assert.equal(validateGatewayURL(host.url + '/'), host.url);
  assert.throws(() => validateGatewayURL('http://100.64.0.1:8083'));
  assert.equal(validateClientConfig({ version: 2, hosts: [host, second] }).hosts.length, 2);
  assert.throws(() => validateClientConfig({ version: 2, hosts: [host, { ...second, gatewayId: host.gatewayId }] }), /Duplicate/);
});

test('catalog preflight authenticates, pins an existing host, and never loads models', async () => {
  const calls = [];
  await preflight(host.url, 'fixture-key', async (url, options) => { calls.push({ url, options }); return ok(catalog); }, host.gatewayId);
  assert.equal(calls.length, 1); assert.match(calls[0].url, /\/local-switch\/models$/);
  assert.equal(calls[0].options.headers.Authorization, 'Bearer fixture-key');
  assert.equal(calls[0].options.headers['x-local-model-gateway-id'], host.gatewayId);
  assert.equal(calls[0].options.redirect, 'error');
  assert.equal((await preflight(host.url, 'fixture-key', async () => ok({ ...catalog, models: MODELS.slice(0, 2) }))).models.length, 2);
  await assert.rejects(preflight(host.url, 'fixture-key', async () => ok(catalog), second.gatewayId), /identity changed/);
  await assert.rejects(preflight(host.url, 'fixture-key', async () => ({ ok: false, status: 401 })), /rejected/);
});

test('four models route through the chosen host, with pins and no secrets in returned status', async () => {
  const calls = [];
  const bridge = createBridge({ getHosts: () => [host, second], ensureGateway: async id => ({ ...(id === host.id ? host : second), baseURL: id === host.id ? host.url : second.url, key: 'fixture-key' }),
    fetcher: async (url, options) => { calls.push(url); const which = url.startsWith(second.url) ? second : host;
      assert.equal(options.headers['x-local-model-gateway-id'], which.gatewayId);
      return ok({ ...stateFor(options.body ? JSON.parse(options.body).model : MODEL_IDS[0], which), credential: 'fixture-key' }); } });
  for (const model of MODEL_IDS) {
    const state = await bridge('prepare', { hostId: second.id, model }); assert.equal(state.loadedModel, model);
    assert.equal(JSON.stringify(state).includes('fixture-key'), false); assert.equal(state.gatewayId, second.gatewayId);
  }
  assert.equal(calls.length, 12); assert.equal(calls.every(url => url.startsWith(second.url)), true);
  assert.equal(JSON.stringify(await bridge('hosts')).includes('credentialRef'), false);
  await assert.rejects(bridge('prepare', { hostId: host.id, model: 'unknown' }));
  assert.throws(() => publicStatus({ ...catalog, version: 1 }));
});

test('wrong server identity is rejected before any prepare', async () => {
  let calls = 0;
  const bridge = createBridge({ ensureGateway: async () => ({ ...host, baseURL: host.url, key: 'fixture-key' }),
    fetcher: async () => { calls++; return ok(stateFor(MODEL_IDS[0], second)); } });
  await assert.rejects(bridge('prepare', { hostId: host.id, model: MODEL_IDS[1] }), /identity/);
  assert.equal(calls, 1);
});

function settingsContext(provider) {
  return { llm: { listConfigurableProviders: () => [{ provider: host.provider, settingsNs: 'pi-ai', settingsPath: ['providers', host.provider] }],
    listProviders: () => [{ id: host.provider }] }, settings: { describe: () => [{ ns: 'pi-ai', value: { providers: { [host.provider]: provider } } }] } };
}
function validProvider() { return { api: 'openai-completions', baseURL: host.url + '/v1', apiKeyEnv: host.credentialRef,
  headers: { 'x-local-model-gateway-id': host.gatewayId }, models: MODELS }; }

test('live provider binding requires exact URL, API, key reference, UUID and no model overrides', () => {
  assert.equal(bindingApplies(settingsContext(validProvider()), host, MODEL_IDS[0]), true);
  for (const change of [{ baseURL: second.url + '/v1' }, { api: 'other' }, { apiKeyEnv: second.credentialRef },
    { headers: {} }, { headers: { ...validProvider().headers, Authorization: 'Bearer fixture' } },
    { headers: { ...validProvider().headers, 'X-API-KEY': 'fixture' } }, { modelOverrides: { [MODEL_IDS[0]]: { baseURL: second.url } } }]) {
    assert.equal(bindingApplies(settingsContext({ ...validProvider(), ...change }), host, MODEL_IDS[0]), false);
  }
});

test('live binding rejects duplicate settings/provider descriptors and unsafe paths', () => {
  const ctx = settingsContext(validProvider()), entries = ctx.llm.listConfigurableProviders();
  ctx.llm.listConfigurableProviders = () => [...entries, ...entries];
  assert.equal(bindingApplies(ctx, host, MODEL_IDS[0]), false);
  ctx.llm.listConfigurableProviders = () => entries;
  const descriptors = ctx.settings.describe(); ctx.settings.describe = () => [...descriptors, ...descriptors];
  assert.equal(bindingApplies(ctx, host, MODEL_IDS[0]), false);
  ctx.settings.describe = () => descriptors;
  for (const settingsPath of [undefined, [], ['__proto__'], ['providers', 'constructor'], 'providers.windows-pc']) {
    ctx.llm.listConfigurableProviders = () => [{ ...entries[0], settingsPath }];
    assert.equal(bindingApplies(ctx, host, MODEL_IDS[0]), false);
  }
});

test('provider edited while the identity probe is pending cannot trigger a prepare', async () => {
  let applies = true, calls = 0;
  const bridge = createBridge({ ensureGateway: async () => ({ ...host, baseURL: host.url, key: 'fixture-key' }), applies: () => applies,
    fetcher: async () => { calls++; applies = false; return ok(stateFor(MODEL_IDS[0])); } });
  assert.equal((await bridge('prepare', { hostId: host.id, model: MODEL_IDS[1] })).applies, false); assert.equal(calls, 1);
});

test('exact RPC route has a unique namespace and validates envelopes', async () => {
  let calls = 0; const route = createFetchRoute('status', async () => { calls++; return { ready: true }; });
  assert.equal(route.path, '/api/windows-model-switch-client/status');
  const request = body => new Request('http://localhost' + route.path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const response = await route.fetch(request({ type: 'client-request', method: 'windows-model-switch-client/status', rpcId: 'test', payload: {} }));
  assert.equal(response.status, 200); assert.equal((await response.json()).result.ok, true); assert.equal(calls, 1);
  assert.equal((await route.fetch(request({}))).status, 400); assert.equal(calls, 1);
});

let client;
vm.runInNewContext(fs.readFileSync(new URL('./plugins/dsh-model-switcher/client.js', import.meta.url), 'utf8'), {
  window: { __ModuleLoader__: { load(module) { client = module.factory(() => ({})); } } }, AbortController, setInterval, clearInterval, Date, URL,
});
const flush = () => new Promise(resolve => setImmediate(resolve));
function controllerFixture(selection = { provider: host.provider, model: MODEL_IDS[0] }, loaded = MODEL_IDS[1], which = host, options = {}) {
  const groups = options.groups || [host, second].map(item => ({ id: item.provider, models: options.models || MODELS }));
  let snapshot = { status: 'ready', current: selection, groups }, block, listener, active = loaded, statusExtra = {};
  const calls = [], selected = [];
  const directory = { getSnapshot: () => snapshot, subscribe(fn) { listener = fn; return () => {}; } };
  const set = value => { snapshot = { groups, ...value }; listener?.(); };
  const controller = client.createController({ directory, sessionId: 'test', hosts: [host, second],
    select: async value => {
      selected.push(value); const previous = snapshot.current;
      set({ status: 'selecting', current: previous, pending: value });
      if (options.select) return options.select(value, { set, previous });
      // Match public ModelDirectory.select: readiness is emitted before the
      // durable history projection changes, not as one combined update.
      set({ status: 'ready', current: previous }); set({ status: 'ready', current: value }); return { ok: true };
    },
    call: async (op, payload) => {
      calls.push({ op, payload });
      if (op === 'catalog') return options.catalog ? options.catalog(payload) : { ...stateFor(null, [host, second].find(item => item.id === payload.hostId)), models: options.models || MODELS };
      const custom = options.call && await options.call(op, payload);
      if (custom !== undefined) return custom;
      if (op === 'prepare') active = payload.model;
      return stateFor(active, options.multiHost ? [host, second].find(item => item.id === payload.hostId) : which, statusExtra);
    },
    blocks: { storeFor: () => ({ getSnapshot: () => block }), set: (_id, value) => { block = value; } }, timer: () => 1, clearTimer() {}, now: options.now,
  });
  return { controller, calls, selected, set, block: () => block, setBlock: value => { block = value; }, setActive: model => { active = model; }, setStatus: value => { statusExtra = value; } };
}

test('opening a mismatched conversation only reads status, blocks chat and offers both choices', async () => {
  const f = controllerFixture(); f.controller.start(); await flush();
  assert.equal(f.calls.some(row => row.op === 'prepare'), false); assert.equal(f.controller.getSnapshot().choice, true);
  assert.match(f.controller.getSnapshot().text, /192\.168\.50\.10/); assert.ok(f.block());
  await f.controller.poll(); assert.equal(f.calls.some(row => row.op === 'prepare'), false); f.controller.dispose(); assert.equal(f.block(), undefined);
});

test('Use loaded model changes only this conversation selection and never prepares', async () => {
  const f = controllerFixture(); f.controller.start(); await flush(); await f.controller.useLoaded(); await flush();
  assert.equal(f.selected.length, 1); assert.equal(f.selected[0].provider, host.provider); assert.equal(f.selected[0].model, MODEL_IDS[1]);
  assert.equal(f.calls.some(row => row.op === 'prepare'), false); assert.equal(f.controller.getSnapshot().ready, true); f.controller.dispose();
});

test('Load conversation model explicitly prepares on the correct host and waits for readiness', async () => {
  const f = controllerFixture({ provider: second.provider, model: MODEL_IDS[2] }, MODEL_IDS[1], second); f.controller.start(); await flush();
  await f.controller.loadConversation(); await flush();
  const calls = f.calls.filter(row => row.op === 'prepare'); assert.equal(calls.length, 1);
  assert.equal(calls[0].payload.hostId, second.id); assert.equal(calls[0].payload.model, MODEL_IDS[2]);
  assert.equal(f.controller.getSnapshot().ready, true); f.controller.dispose();
});

test('explicit dropdown changes prepare once; passive selection updates and subsequent polling never switch', async () => {
  const f = controllerFixture(); f.controller.start(); await flush();
  f.set({ status: 'selecting', current: { provider: host.provider, model: MODEL_IDS[0] }, pending: { provider: host.provider, model: MODEL_IDS[2] } });
  f.set({ status: 'ready', current: { provider: host.provider, model: MODEL_IDS[2] } }); await flush();
  assert.equal(f.calls.filter(row => row.op === 'prepare').length, 1);
  f.set({ status: 'ready', current: { provider: host.provider, model: MODEL_IDS[3] } }); await flush(); await f.controller.poll();
  assert.equal(f.calls.filter(row => row.op === 'prepare').length, 1); f.controller.dispose();
});

test('native directory ready-before-current sequence retains explicit intent exactly once', async () => {
  const f = controllerFixture(); f.controller.start(); await flush();
  const before = { provider: host.provider, model: MODEL_IDS[0] }, target = { provider: host.provider, model: MODEL_IDS[2] };
  f.set({ status: 'selecting', current: before, pending: target });
  f.set({ status: 'ready', current: before }); f.set({ status: 'ready', current: target }); await flush();
  assert.deepEqual(f.calls.filter(row => row.op === 'prepare').map(row => row.payload.model), [target.model]);
  f.controller.dispose();
});

test('opening during an existing selection observes its commit without preparing', async () => {
  const f = controllerFixture();
  const before = { provider: host.provider, model: MODEL_IDS[0] }, target = { provider: host.provider, model: MODEL_IDS[2] };
  f.set({ status: 'selecting', current: before, pending: target }); f.controller.start();
  f.set({ status: 'ready', current: before }); f.set({ status: 'ready', current: target }); await flush();
  assert.equal(f.calls.some(row => row.op === 'prepare'), false); f.controller.dispose();
});

test('pill selection preflights the bound target and prepares one time after durable selection', async () => {
  const f = controllerFixture(); f.controller.start(); await flush();
  assert.equal(await f.controller.selectInstalled(MODEL_IDS[2]), true); await flush();
  assert.equal(f.selected.length, 1); assert.equal(f.selected[0].provider, host.provider);
  assert.equal(f.selected[0].reasoningEffort, 'off');
  const targetCalls = f.calls.filter(row => row.payload.model === MODEL_IDS[2]);
  assert.equal(targetCalls[0].op, 'status');
  assert.deepEqual(f.calls.filter(row => row.op === 'prepare').map(row => row.payload.model), [MODEL_IDS[2]]);
  assert.equal(f.controller.getSnapshot().ready, true); f.controller.dispose();
});

test('same selected inactive model explicitly loads; same ready model only inspects', async () => {
  const f = controllerFixture(); f.controller.start(); await flush();
  assert.equal(await f.controller.selectInstalled(MODEL_IDS[0]), true); await flush();
  assert.equal(f.selected.length, 0); assert.equal(f.calls.filter(row => row.op === 'prepare').length, 1);
  assert.equal(await f.controller.selectInstalled(MODEL_IDS[0]), true); await flush();
  assert.equal(f.selected.length, 0); assert.equal(f.calls.filter(row => row.op === 'prepare').length, 1); f.controller.dispose();
});

test('pill may select only installed models on a registered host and uses that exact provider', async () => {
  const f = controllerFixture(undefined, MODEL_IDS[1], host, { multiHost: true }); f.controller.start(); await flush();
  assert.equal(await f.controller.selectInstalled(MODEL_IDS[2], 'unknown'), false);
  assert.equal(await f.controller.selectInstalled('foreign-model', host.id), false);
  assert.equal(f.selected.length, 0);
  assert.equal(await f.controller.selectInstalled(MODEL_IDS[2], second.id), true); await flush();
  assert.equal(f.selected[0].provider, second.provider);
  assert.equal(f.calls.filter(row => row.op === 'prepare')[0].payload.hostId, second.id);
  assert.equal(f.controller.getSnapshot().currentHost.id, second.id); f.controller.dispose();
  const removed = controllerFixture(); removed.controller.start(); await flush();
  removed.set({ status: 'ready', current: { provider: host.provider, model: MODEL_IDS[0] }, groups: [{ id: host.provider, models: [MODELS[0]] }] });
  assert.equal(await removed.controller.selectInstalled(MODEL_IDS[2]), false); assert.equal(removed.selected.length, 0); removed.controller.dispose();
});

test('model-bound status rejects redirected provider before selection or preparation', async () => {
  const f = controllerFixture(undefined, MODEL_IDS[1], host, {
    call: (op, payload) => payload.model === MODEL_IDS[2] ? { applies: false } : undefined,
  });
  f.controller.start(); await flush(); assert.equal(await f.controller.selectInstalled(MODEL_IDS[2]), false);
  assert.equal(f.selected.length, 0); assert.equal(f.calls.some(row => row.op === 'prepare'), false);
  assert.equal(f.controller.getSnapshot().error, true); f.controller.dispose();
});

test('public select ok:false does not prepare or report success', async () => {
  const f = controllerFixture(undefined, MODEL_IDS[1], host, {
    select: (_value, { set, previous }) => { set({ status: 'error', current: previous }); return { ok: false, error: { message: 'Rejected' } }; },
  });
  f.controller.start(); await flush(); assert.equal(await f.controller.selectInstalled(MODEL_IDS[2]), false); await flush();
  assert.equal(f.calls.some(row => row.op === 'prepare'), false); assert.equal(f.controller.getSnapshot().error, true);
  assert.equal(f.controller.getSnapshot().currentModel, MODEL_IDS[0]); f.controller.dispose();
});

test('failed selection remains visible with the old model ready and composer usable, then dismisses', async () => {
  const f = controllerFixture(undefined, MODEL_IDS[0], host, {
    select: (_value, { set, previous }) => { set({ status: 'error', current: previous }); return { ok: false }; },
  });
  f.controller.start(); await flush(); await f.controller.selectInstalled(MODEL_IDS[2]); await flush(); await f.controller.poll();
  assert.equal(f.controller.getSnapshot().ready, true); assert.equal(f.controller.getSnapshot().error, true);
  assert.match(f.controller.getSnapshot().selectionError, /Could not select/); assert.equal(f.block(), undefined);
  f.controller.dismissSelectionError(); assert.equal(f.controller.getSnapshot().selectionError, null);
  assert.equal(f.controller.getSnapshot().error, false); assert.equal(f.controller.getSnapshot().ready, true); f.controller.dispose();
});

test('portable load failures clear on actual recovery while a later choice clears selection errors', async () => {
  let rejectSelection = true, failLoad = false;
  const f = controllerFixture(undefined, MODEL_IDS[0], host, {
    select: (value, { set, previous }) => {
      set({ status: rejectSelection ? 'error' : 'ready', current: rejectSelection ? previous : value }); return { ok: !rejectSelection };
    },
    call: op => { if (op === 'prepare' && failLoad) throw new Error('fixture failure'); },
  });
  f.controller.start(); await flush(); await f.controller.selectInstalled(MODEL_IDS[2]); await flush();
  assert.ok(f.controller.getSnapshot().selectionError);
  rejectSelection = false; await f.controller.selectInstalled(MODEL_IDS[2]); await flush();
  assert.equal(f.controller.getSnapshot().selectionError, null); assert.equal(f.controller.getSnapshot().ready, true);
  f.setActive(MODEL_IDS[0]); failLoad = true; await f.controller.poll(); await f.controller.loadConversation(); await flush();
  assert.equal(f.controller.getSnapshot().error, true);
  f.setActive(MODEL_IDS[2]); await f.controller.poll(); assert.equal(f.controller.getSnapshot().error, false);
  assert.equal(f.controller.getSnapshot().ready, true); f.controller.dispose();
});

test('Use loaded performs a fresh model-bound check and handles false selection outcomes', async () => {
  let changed = false;
  const f = controllerFixture(undefined, MODEL_IDS[1], host, {
    call: (op, payload) => changed && payload.model === MODEL_IDS[1] ? stateFor(MODEL_IDS[2]) : undefined,
  });
  f.controller.start(); await flush(); changed = true;
  assert.equal(await f.controller.useLoaded(), false); assert.equal(f.selected.length, 0);
  assert.equal(f.calls.some(row => row.op === 'prepare'), false); f.controller.dispose();
  const rejected = controllerFixture(undefined, MODEL_IDS[1], host, {
    select: (_value, { set, previous }) => { set({ status: 'error', current: previous }); return { ok: false }; },
  });
  rejected.controller.start(); await flush(); assert.equal(await rejected.controller.useLoaded(), false); await flush();
  assert.equal(rejected.controller.getSnapshot().error, true); assert.equal(rejected.calls.some(row => row.op === 'prepare'), false); rejected.controller.dispose();
});

test('passive route change during preflight cancels stale pill selection', async () => {
  let release;
  const f = controllerFixture(undefined, MODEL_IDS[1], host, {
    call: (_op, payload) => payload.model === MODEL_IDS[2] ? new Promise(resolve => { release = resolve; }) : undefined,
  });
  f.controller.start(); await flush(); const pending = f.controller.selectInstalled(MODEL_IDS[2]); await flush();
  f.set({ status: 'ready', current: { provider: 'cloud', model: 'other' } });
  release(stateFor(MODEL_IDS[1])); assert.equal(await pending, false); await flush();
  assert.equal(f.selected.length, 0); assert.equal(f.calls.some(row => row.op === 'prepare'), false);
  assert.equal(f.controller.getSnapshot().visible, false); assert.equal(f.block(), undefined); f.controller.dispose();
});

test('newer native selection prevents a late pill selection from preparing its old target', async () => {
  let release;
  const f = controllerFixture(undefined, MODEL_IDS[1], host, {
    select: () => new Promise(resolve => { release = resolve; }),
  });
  f.controller.start(); await flush(); const pending = f.controller.selectInstalled(MODEL_IDS[2]); await flush();
  const latest = { provider: host.provider, model: MODEL_IDS[3] };
  f.set({ status: 'selecting', current: { provider: host.provider, model: MODEL_IDS[0] }, pending: latest });
  f.set({ status: 'ready', current: latest }); await flush(); release({ ok: true });
  assert.equal(await pending, false); await flush();
  assert.deepEqual(f.calls.filter(row => row.op === 'prepare').map(row => row.payload.model), [latest.model]); f.controller.dispose();
});

test('progress uses real phases and elapsed observation time, not conversation age', async () => {
  let clock = 1000;
  const f = controllerFixture(undefined, MODEL_IDS[1], host, { now: () => clock }); f.controller.start(); await flush();
  clock = 61000; await f.controller.poll(); assert.equal(f.controller.getSnapshot().seconds, 0);
  f.setStatus({ phase: 'unloading', loadingModel: MODEL_IDS[2] }); await f.controller.poll();
  assert.equal(f.controller.getSnapshot().phase, 'unloading'); assert.equal(f.controller.getSnapshot().seconds, 0);
  clock += 8000; f.setStatus({ phase: 'loading', loadingModel: MODEL_IDS[2] }); await f.controller.poll();
  assert.equal(f.controller.getSnapshot().seconds, 8); assert.equal(f.controller.getSnapshot().loadingModel, MODEL_IDS[2]);
  f.setStatus({ phase: 'serving', activeRequests: 1, desiredModel: MODEL_IDS[2] }); await f.controller.poll();
  assert.equal(f.controller.getSnapshot().phase, 'waiting'); assert.equal(f.controller.getSnapshot().busy, true);
  f.setStatus({}); await f.controller.poll(); assert.equal(f.controller.getSnapshot().seconds, 0); f.controller.dispose();
});

test('a different plugin block with identical reason remains owned by that plugin', async () => {
  const f = controllerFixture(); f.controller.start(); await flush();
  const other = { reason: f.block().reason }; f.setBlock(other); await f.controller.poll();
  assert.equal(f.block(), other); f.controller.dispose(); assert.equal(f.block(), other);
});

test('error, unknown phase, and inapplicable statuses never claim model readiness', () => {
  const route = client.routeOf({ provider: host.provider, model: MODEL_IDS[0] }, [host]);
  for (const extra of [{ phase: 'error' }, { phase: 'unknown' }, { error: 'failed' }, { applies: false },
    { phase: 'serving', activeRequests: 1, desiredModel: MODEL_IDS[2] }]) {
    assert.equal(client.readyFor(stateFor(MODEL_IDS[0], host, extra), route), false);
  }
});

test('pill opens locally as a real button and keeps actual loading progress in its collapsed header', () => {
  let component, renderedState, hookIndex = 0, rpcCalls = 0, selected = 0, ui;
  const hookValues = [];
  const react = {
    Fragment: 'fragment',
    createElement: (type, props, ...children) => ({ type, props: props || {}, children: children.flat(Infinity).filter(child => child !== null && child !== undefined && child !== false) }),
    useState(initial) { const index = hookIndex++; if (!(index in hookValues)) hookValues[index] = initial;
      return [hookValues[index], value => { hookValues[index] = typeof value === 'function' ? value(hookValues[index]) : value; }]; },
    useMemo: create => create(), useEffect() {}, useId: () => 'host-panel', useSyncExternalStore: () => renderedState,
  };
  vm.runInNewContext(fs.readFileSync(new URL('./plugins/dsh-model-switcher/client.js', import.meta.url), 'utf8'), {
    window: { __ModuleLoader__: { load(module) { ui = module.factory(() => react); } } }, AbortController, setInterval, clearInterval, Date, URL,
  });
  ui.apply({
    slots: { inject: (_slot, register) => register(), register: (_options, value) => { component = value; } },
    connection: { rpc: { call: async () => { rpcCalls++; return { ok: true, value: { hosts: [host] } }; } } },
    conversation: { blocks: {} },
  });
  const directory = { store: { getSnapshot: () => ({}) }, select: () => { selected++; } };
  renderedState = { visible: true, ready: true, busy: false, error: false, choice: false, text: 'Ready', seconds: 0,
    host: `${host.label} (${new URL(host.url).host})`, hosts: [host, second], currentHost: host,
    currentModel: MODEL_IDS[0], activeModel: MODEL_IDS[0], activeLabel: 'Qwen Flash', targetLabel: 'Qwen Flash',
    phase: 'ready', modelAvailable: true, modelCatalogs: { [host.id]: MODELS, [second.id]: MODELS },
    availableModels: { [host.id]: MODEL_IDS, [second.id]: MODEL_IDS } };
  const render = () => { hookIndex = 0; return component({ sessionId: 'ui-test', modelDirectory: directory }); };
  const nodes = tree => typeof tree === 'object' ? [tree, ...tree.children.flatMap(nodes)] : [];
  const words = tree => typeof tree === 'object' ? tree.children.map(words).join(' ') : String(tree);
  let tree = render(), header = nodes(tree).find(node => node.props.className === 'dsh-model-host-header');
  assert.equal(header.type, 'button'); assert.equal(header.props['aria-expanded'], false);
  assert.equal(nodes(header).filter(node => node.type === 'button').length, 1);
  header.props.onClick(); tree = render();
  assert.equal(nodes(tree).find(node => node.props.id === 'host-panel').props.hidden, false);
  assert.equal(nodes(tree).filter(node => node.type === 'button' && MODEL_IDS.includes(node.props.title)).length, 4);
  assert.match(words(tree), /http:\/\/192\.168\.50\.10:8083/);
  assert.equal(rpcCalls, 0); assert.equal(selected, 0);
  hookValues[1] = false; renderedState = { ...renderedState, ready: false, busy: true, phase: 'unloading', loadingModel: MODEL_IDS[2], seconds: 14 };
  tree = render(); header = nodes(tree).find(node => node.props.className === 'dsh-model-host-header');
  assert.equal(header.props['aria-expanded'], false); assert.match(words(header), /Qwen 27B/);
  assert.match(words(header), /Unloading/); assert.match(words(header), /14s/);
  assert.equal(nodes(tree).find(node => node.props.id === 'host-panel').props.hidden, true);
  assert.equal(rpcCalls, 0); assert.equal(selected, 0);
  renderedState = { ...renderedState, ready: true, busy: false, error: true, selectionError: 'Selection failed', text: 'Selection failed' };
  tree = render(); assert.equal(nodes(tree).find(node => node.props.id === 'host-panel').props.hidden, false);
  assert.ok(nodes(tree).some(node => node.type === 'button' && node.children.includes('Dismiss')));
  assert.equal(nodes(tree).find(node => node.props.className === 'dsh-model-host-badge').props['data-tone'], 'error');
});

test('unrelated providers allow only background catalog reads and wrong UUID never appears ready', async () => {
  const f = controllerFixture({ provider: 'local-mlx', model: MODEL_IDS[0] }); f.controller.start(); await flush();
  assert.equal(f.calls.every(row => row.op === 'catalog'), true); assert.equal(f.block(), undefined); f.controller.dispose();
  const wrong = controllerFixture({ provider: host.provider, model: MODEL_IDS[0] }, MODEL_IDS[0], second); wrong.controller.start(); await flush();
  assert.equal(wrong.controller.getSnapshot().ready, false); assert.equal(wrong.controller.getSnapshot().error, true);
  assert.equal(wrong.calls.some(row => row.op === 'prepare'), false); wrong.controller.dispose();
});

test('another device changing the loaded model produces a choice, never an automatic reload', async () => {
  const f = controllerFixture({ provider: host.provider, model: MODEL_IDS[0] }, MODEL_IDS[0]); f.controller.start(); await flush();
  assert.equal(f.controller.getSnapshot().ready, true); f.setActive(MODEL_IDS[1]); await f.controller.poll();
  assert.equal(f.controller.getSnapshot().choice, true); assert.ok(f.block()); assert.equal(f.calls.some(row => row.op === 'prepare'), false); f.controller.dispose();
});

test('remote loading reports the actual incoming model and keeps this conversation blocked', async () => {
  const f = controllerFixture({ provider: host.provider, model: MODEL_IDS[0] }, MODEL_IDS[0]); f.controller.start(); await flush();
  f.setStatus({ phase: 'loading', loadingModel: MODEL_IDS[1], desiredModel: MODEL_IDS[2] }); await f.controller.poll();
  let state = f.controller.getSnapshot();
  assert.match(state.text, /loading SC117 Flash IQ3_S\. This conversation uses Qwen Flash Q4\./);
  assert.equal(state.ready, false); assert.equal(state.busy, true); assert.equal(state.choice, false); assert.ok(f.block());
  f.setStatus({ phase: 'waiting', desiredModel: MODEL_IDS[2] }); await f.controller.poll();
  assert.match(f.controller.getSnapshot().text, /waiting to prepare Qwen 27B Q4\. This conversation uses Qwen Flash Q4\./);
  f.setStatus({ phase: 'loading' }); await f.controller.poll();
  assert.match(f.controller.getSnapshot().text, /model switch is in progress/);
  assert.doesNotMatch(f.controller.getSnapshot().text, /loading Qwen Flash/);
  f.setActive(MODEL_IDS[1]); f.setStatus({}); await f.controller.poll(); state = f.controller.getSnapshot();
  assert.equal(state.choice, true); assert.equal(state.activeLabel, MODELS[1].name); assert.equal(state.targetLabel, MODELS[0].name);
  assert.equal(f.calls.some(row => row.op === 'prepare'), false); f.controller.dispose();
});

test('host configuration failure never blocks an unrelated Mac or cloud provider', async () => {
  let block;
  const controller = client.createController({ directory: { getSnapshot: () => ({ current: { provider: 'local-mlx', model: 'local' } }), subscribe: () => () => {} },
    select: async () => {}, call: async () => { throw new Error('offline'); }, sessionId: 'other',
    blocks: { storeFor: () => ({ getSnapshot: () => block }), set: (_id, value) => { block = value; } }, timer: () => 1, clearTimer() {} });
  controller.start(); await flush(); assert.equal(controller.getSnapshot().visible, false); assert.equal(block, undefined); controller.dispose();
});

test('a loading transition never enables chat on the old resident model', () => {
  const route = client.routeOf({ provider: host.provider, model: MODEL_IDS[0] }, [host, second]);
  for (const phase of ['checking', 'waiting', 'unloading', 'releasing', 'loading']) assert.equal(client.readyFor(stateFor(MODEL_IDS[0], host, { phase }), route), false);
});

test('private config resolves only the selected host credential without a duplicate key file', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-client-settings-'));
  fs.writeFileSync(path.join(home, 'local-model-switch-client.json'), JSON.stringify({ version: 2, hosts: [host, second] }));
  const result = await loadGatewayConfig({ hostId: second.id, home, resolveCredential: async ref => { assert.equal(ref, second.credentialRef); return { value: 'fixture-key' }; } });
  assert.equal(result.baseURL, second.url); assert.equal(result.key, 'fixture-key'); assert.equal(result.gatewayId, second.gatewayId);
  fs.unlinkSync(path.join(home, 'local-model-switch-client.json')); fs.rmdirSync(home);
});

function cleanTransaction(home) {
  for (const sub of fs.readdirSync(path.join(home, 'backups'))) { const dir = path.join(home, 'backups', sub); for (const name of fs.readdirSync(dir)) fs.unlinkSync(path.join(dir, name)); fs.rmdirSync(dir); }
  fs.rmdirSync(path.join(home, 'backups')); for (const name of fs.readdirSync(home)) fs.unlinkSync(path.join(home, name)); fs.rmdirSync(home);
}
test('failed installation restores its writes and successful installation can roll back', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-client-transaction-')), file = path.join(home, 'profile.yml'); fs.writeFileSync(file, 'before');
  let calls = 0;
  assert.throws(() => applyTransaction([{ filename: file, content: 'after' }, { filename: path.join(home, 'new.json'), content: '{}' }],
    { home, backupRoot: path.join(home, 'backups/failed'), closedCheck() { calls++; if (calls === 3) throw new Error('changed'); } }), /changed/);
  assert.equal(fs.readFileSync(file, 'utf8'), 'before'); assert.equal(fs.existsSync(path.join(home, 'new.json')), false);
  const backup = path.join(home, 'backups/success');
  applyTransaction([{ filename: file, content: 'after' }, { filename: path.join(home, 'new.json'), content: '{}' }], { home, backupRoot: backup, closedCheck() {} });
  rollback(backup, { home, closedCheck() {} }); assert.equal(fs.readFileSync(file, 'utf8'), 'before'); assert.equal(fs.existsSync(path.join(home, 'new.json')), false); cleanTransaction(home);
});

test('rollback refuses to overwrite newer changes', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-client-rollback-')), file = path.join(home, 'profile.yml'), backup = path.join(home, 'backups/success'); fs.writeFileSync(file, 'before');
  applyTransaction([{ filename: file, content: 'after' }], { home, backupRoot: backup, closedCheck() {} }); fs.writeFileSync(file, 'newer');
  assert.throws(() => rollback(backup, { home, closedCheck() {} }), /preserve newer settings/); assert.equal(fs.readFileSync(file, 'utf8'), 'newer'); cleanTransaction(home);
});

test('runtime contains no Windows process launch or model download commands', () => {
  for (const filename of ['index.mjs', 'settings.mjs', 'catalog.mjs', 'client.js']) {
    const text = fs.readFileSync(new URL(`./plugins/dsh-model-switcher/${filename}`, import.meta.url), 'utf8');
    assert.doesNotMatch(text, /C:\\Users|V:\\LocalAI|powershell|nvidia-smi|child_process|huggingface|strata\.exe/);
  }
});

test('dynamic catalogs validate capabilities and reject duplicates, unsafe metadata and endpoint injection', () => {
  const novel = { ...MODELS[0], id: 'team/model:Q4_K_M', name: 'Office reasoning model', provider: 'untrusted-route' };
  assert.deepEqual(validateModels([novel])[0], { ...MODELS[0], id: novel.id, name: novel.name });
  assert.deepEqual(validateModels([{ ...novel, reasoningEfforts: undefined }])[0].reasoningEfforts, false);
  assert.deepEqual(validateCatalog({ ...catalog, models: [] }, host.gatewayId).models, []);
  for (const patch of [{ id: 'constructor' }, { id: '../bad model' }, { name: 'Bad\nname' }, { name: 'x'.repeat(201) },
    { contextWindow: Infinity }, { maxTokens: 9999999 }, { input: ['image'] }, { input: ['text', 'text'] },
    { reasoningEfforts: { off: 'none' } }, { reasoningEfforts: { medium: 'injected' } },
    { headers: { Authorization: 'secret' } }, { baseURL: 'https://example.com' }, { apiKeyEnv: 'OTHER' }]) {
    assert.throws(() => validateModels([{ ...novel, ...patch }]));
  }
  assert.throws(() => validateModels([novel, novel]));
  assert.throws(() => validateModels(Array.from({ length: 257 }, (_, i) => ({ ...novel, id: `m-${i}` }))));
  assert.throws(() => validateCatalog({ ...catalog, gatewayId: second.gatewayId }, host.gatewayId), /identity/);
});

test('catalog polling adds, renames and removes arbitrary models without ever preparing one', async () => {
  let clock = 0, rows = [{ ...MODELS[0], id: 'new-model:4b', name: 'New small model' }];
  const calls = [], synchronized = [];
  const bridge = createBridge({ now: () => clock, ensureGateway: async () => ({ ...host, baseURL: host.url, key: 'fixture-key' }),
    synchronize: async (_host, value) => synchronized.push(value), fetcher: async (url, options) => {
      calls.push({ url, method: options.method });
      return ok(url.endsWith('/models') ? { ...catalog, models: rows } : stateFor('new-model:4b'));
    } });
  const first = await bridge('status', { hostId: host.id, model: rows[0].id });
  assert.equal(first.modelAvailable, true); assert.equal(first.models[0].name, 'New small model');
  rows = [{ ...rows[0], name: 'Renamed small model' }, { ...MODELS[1], id: 'another/new-model', name: 'Another model' }];
  await bridge('status', { hostId: host.id, model: rows[0].id });
  assert.equal(calls.filter(row => row.url.endsWith('/models')).length, 1);
  clock = 30001;
  const secondRead = await bridge('catalog', { hostId: host.id });
  assert.deepEqual(secondRead.models.map(row => row.name), ['Renamed small model', 'Another model']);
  rows = [];
  await assert.rejects(bridge('prepare', { hostId: host.id, model: 'new-model:4b' }), /not currently available/);
  assert.equal(calls.some(row => row.method === 'POST'), false);
  assert.deepEqual(synchronized.at(-1), []);
  assert.equal((await bridge('status', { hostId: host.id, model: 'new-model:4b' })).modelAvailable, false);
});

test('catalog failures clear available choices, never use an installer seed, and recover on refresh', async () => {
  let fail = true;
  const bridge = createBridge({ ensureGateway: async () => ({ ...host, models: MODELS, baseURL: host.url, key: 'fixture-key' }),
    fetcher: async url => {
      if (url.endsWith('/models')) { if (fail) throw new Error('offline'); return ok(catalog); }
      return ok(stateFor(MODEL_IDS[0]));
    } });
  let result = await bridge('status', { hostId: host.id, model: MODEL_IDS[0] });
  assert.equal(result.catalogReady, false); assert.deepEqual(result.models, []); assert.equal(result.modelAvailable, false);
  fail = false;
  result = await bridge('catalog', { hostId: host.id, refresh: true });
  assert.equal(result.catalogReady, true); assert.equal(result.models.length, 4);
});

test('concurrent catalog readers share one identity-checked refresh and one provider mutation', async () => {
  let release, requests = 0, writes = 0;
  const pending = new Promise(resolve => { release = resolve; });
  const bridge = createBridge({ ensureGateway: async () => ({ ...host, baseURL: host.url, key: 'fixture-key' }),
    synchronize: async () => { writes++; }, fetcher: async () => { requests++; await pending; return ok(catalog); } });
  const first = bridge('catalog', { hostId: host.id }), secondRead = bridge('catalog', { hostId: host.id, refresh: true });
  await flush(); assert.equal(requests, 1); release(); await Promise.all([first, secondRead]);
  assert.equal(writes, 1);
});

test('matching model IDs on separate hosts keep independent names and cache entries', async () => {
  const bridge = createBridge({ ensureGateway: async id => { const value = id === host.id ? host : second; return { ...value, baseURL: value.url, key: 'fixture-key' }; },
    fetcher: async url => { const which = url.startsWith(host.url) ? host : second;
      return ok({ ...catalog, gatewayId: which.gatewayId, models: [{ ...MODELS[0], name: `${which.label} model` }] }); } });
  assert.equal((await bridge('catalog', { hostId: host.id })).models[0].name, `${host.label} model`);
  assert.equal((await bridge('catalog', { hostId: second.id })).models[0].name, `${second.label} model`);
  assert.equal((await bridge('catalog', { hostId: host.id })).models[0].name, `${host.label} model`);
});

test('live synchronization edits only the pinned provider model field with a revision guard', async () => {
  const provider = structuredClone(validProvider()), ctx = settingsContext(provider), calls = [];
  ctx.settings.describe = () => [{ ns: 'pi-ai', revision: 7, value: { providers: { [host.provider]: provider, cloud: { apiKeyEnv: 'SECRET_REF' } } } }];
  ctx.settings.mutate = async (ns, ops, revision) => {
    calls.push({ ns, ops, revision }); provider.models = ops[0].value;
  };
  const next = [{ ...MODELS[0], id: 'dynamic-model', name: 'Dynamic model' }];
  assert.equal(await synchronizeProviderModels(ctx, host, next), true);
  assert.deepEqual(calls, [{ ns: 'pi-ai', ops: [{ op: 'set', path: ['providers', host.provider, 'models'], value: next }], revision: 7 }]);
  assert.equal(await synchronizeProviderModels(ctx, host, next), false);
  assert.equal(await synchronizeProviderModels(ctx, host, []), false);
  assert.equal(calls.length, 1); assert.equal(provider.apiKeyEnv, host.credentialRef);
  provider.baseURL = second.url + '/v1';
  await assert.rejects(synchronizeProviderModels(ctx, host, MODELS), /binding changed/);
  assert.equal(calls.length, 1);
});

test('revision conflict cannot overwrite a host redirected while model synchronization was pending', async () => {
  const provider = structuredClone(validProvider()), ctx = settingsContext(provider);
  ctx.settings.describe = () => [{ ns: 'pi-ai', revision: 7, value: { providers: { [host.provider]: provider } } }];
  let calls = 0;
  ctx.settings.mutate = async () => { calls++; provider.baseURL = second.url + '/v1'; throw Object.assign(new Error('changed'), { code: 'SETTINGS_CONFLICT' }); };
  await assert.rejects(synchronizeProviderModels(ctx, host, [MODELS[0]]), /binding changed/);
  assert.equal(calls, 1);
});

test('schema-added empty compatibility defaults do not cause repeated catalog writes', async () => {
  const provider = structuredClone(validProvider());
  provider.models = provider.models.map(model => ({ ...model, compat: { chatTemplateKwargs: {}, chatTemplateArgs: {} } }));
  const ctx = settingsContext(provider);
  ctx.settings.mutate = async () => { assert.fail('unchanged normalized catalog must not write'); };
  assert.equal(await synchronizeProviderModels(ctx, host, MODELS), false);
});

test('installed SettingsForms, Loader and PiAiAdapter refresh models without repeated writes or changing another provider', {
  skip: !process.env.DSH_DELETE_TEST_PACKAGE_ROOT,
}, async () => {
  const packageRoot = process.env.DSH_DELETE_TEST_PACKAGE_ROOT;
  const load = name => import(pathToFileURL(path.join(packageRoot, name, 'lib/index.js')).href);
  const [{ Context }, { default: Loader }, { default: Settings }, llm] = await Promise.all([
    load('cordis'), load('cordis-plugin-loader'), load('dsh-settings'), load('dsh-llm'),
  ]);
  const temporaryParent = fs.realpathSync(os.tmpdir());
  const temporary = fs.mkdtempSync(path.join(temporaryParent, 'dsh-native-catalog-'));
  const ctx = new Context(), fibers = [];
  let entry, edits = 0;
  try {
    ctx.provide('profileContext', { home: temporary, dir: temporary,
      patchPath: path.join(temporary, 'profile.yml'), name: 'synthetic' });
    ctx.provide('credentials', { resolve: async ref => ref === host.credentialRef ? { value: 'synthetic-fixture-only' } : undefined,
      get: async () => undefined });
    const loader = ctx.plugin(Loader, { baseUrl: pathToFileURL(temporary + path.sep).href });
    fibers.push(loader); await loader.await();
    // Persistence alone is an in-memory shim. The actual SettingsForms performs
    // validation/revision checks and the actual Loader reconciles live config.
    ctx.provide('configEditor', {
      documentPath: path.join(temporary, 'profile.yml'), entries: () => entry ? [entry] : [],
      configuration: () => entry ? [{ entry, inherited: {}, override: structuredClone(entry.options.config) }] : [],
      async edit(target, change) {
        assert.equal(target, entry); edits++;
        await ctx.loader.update(entry.id, { config: change(structuredClone(entry.options.config), {}) });
      },
    });
    for (const plugin of [llm.default || llm, Settings]) {
      const fiber = ctx.plugin(plugin); fibers.push(fiber); await fiber.await();
    }
    const id = await ctx.loader.create({ name: pathToFileURL(path.join(packageRoot, 'dsh-llm-pi-ai/lib/index.js')).href,
      config: { providers: { [host.provider]: validProvider(),
        independent: { api: 'openai-completions', baseURL: 'http://127.0.0.1:18084/v1', apiKeyEnv: host.credentialRef,
          models: [{ ...MODELS[0], id: 'independent-model' }] } } } });
    entry = ctx.loader.resolve(id); await ctx.loader.await();
    const independent = await ctx.llm.listModels('independent');
    assert.deepEqual(independent.map(model => model.id), ['independent-model']);
    const next = [{ ...MODELS[0], id: 'synthetic-new-model', name: 'Synthetic new model', reasoningEfforts: false }];
    assert.equal(await synchronizeProviderModels(ctx, host, next), true);
    assert.deepEqual((await ctx.llm.listModels(host.provider)).map(model => model.id), ['synthetic-new-model']);
    assert.deepEqual(await ctx.llm.listModels('independent'), independent);
    assert.equal(entry.options.config.providers[host.provider].apiKeyEnv, host.credentialRef);
    assert.deepEqual(entry.options.config.providers[host.provider].headers, validProvider().headers);
    assert.equal(await synchronizeProviderModels(ctx, host, next), false);
    assert.equal(await synchronizeProviderModels(ctx, host, next), false);
    assert.equal(edits, 1);
  } finally {
    for (const fiber of fibers.reverse()) await fiber.dispose();
    const resolved = fs.realpathSync(temporary);
    assert.equal(path.dirname(resolved), temporaryParent); assert.match(path.basename(resolved), /^dsh-native-catalog-/);
    fs.rmSync(resolved, { recursive: true });
  }
});

test('removed conversation model stays visible and blocked instead of becoming an unmanaged chat', async () => {
  const f = controllerFixture({ provider: host.provider, model: MODEL_IDS[0] }, MODEL_IDS[0]);
  f.controller.start(); await flush(); assert.equal(f.controller.getSnapshot().ready, true);
  f.setStatus({ models: [], catalogReady: true }); await f.controller.poll();
  const value = f.controller.getSnapshot();
  assert.equal(value.visible, true); assert.equal(value.ready, false); assert.equal(value.modelAvailable, false);
  assert.equal(value.currentModel, MODEL_IDS[0]); assert.match(value.text, /unavailable/); assert.ok(f.block());
  assert.equal(value.availableModels[host.id].length, 0);
  await f.controller.loadConversation(); assert.equal(f.calls.some(row => row.op === 'prepare'), false);
  f.controller.dispose();
});

test('new model names arrive from a fresh catalog and can be selected without a client release', async () => {
  const next = { ...MODELS[0], id: 'future/model:q4', name: 'Future reasoning model' };
  const models = [...MODELS, next];
  const f = controllerFixture(undefined, MODEL_IDS[0], host, { models,
    call: (op, payload) => op === 'status' ? stateFor(MODEL_IDS[0], host, { models }) : op === 'prepare' ? stateFor(payload.model, host, { models }) : undefined });
  f.controller.start(); await flush();
  assert.equal(f.controller.getSnapshot().availableModels[host.id].includes(next.id), true);
  assert.equal(await f.controller.selectInstalled(next.id), true);
  assert.equal(f.selected[0].model, next.id);
  assert.equal(f.calls.filter(row => row.op === 'prepare').length, 1);
  assert.equal(f.controller.getSnapshot().targetLabel, next.name);
  f.controller.dispose();
});

test('initial seed never opens the composer before fresh host availability arrives', async () => {
  let release;
  const pending = new Promise(resolve => { release = resolve; });
  const f = controllerFixture(undefined, MODEL_IDS[0], host, { catalog: async () => { await pending; return { ...stateFor(null), models: MODELS }; },
    call: async () => { await pending; return stateFor(MODEL_IDS[0]); } });
  f.controller.start();
  assert.equal(f.controller.getSnapshot().ready, false); assert.ok(f.block());
  assert.equal(f.controller.getSnapshot().availableModels[host.id].length, 0);
  release(); await flush(); assert.equal(f.controller.getSnapshot().ready, true);
  assert.equal(f.calls.some(row => row.op === 'prepare'), false); f.controller.dispose();
});

test('dynamic selection omits effort for nonreasoning models and chooses a supported level when off is absent', async () => {
  for (const [reasoningEfforts, expected] of [[false, undefined], [{ medium: 'medium', high: 'high' }, 'medium']]) {
    const next = { ...MODELS[0], id: 'dynamic-reasoning-model', name: 'Dynamic model', reasoningEfforts };
    const models = [...MODELS, next];
    const f = controllerFixture(undefined, MODEL_IDS[0], host, { models,
      call: (op, payload) => op === 'status' ? stateFor(MODEL_IDS[0], host, { models }) : op === 'prepare' ? stateFor(payload.model, host, { models }) : undefined });
    f.controller.start(); await flush(); await f.controller.selectInstalled(next.id);
    assert.equal(f.selected[0].reasoningEffort, expected);
    if (expected === undefined) assert.equal(Object.hasOwn(f.selected[0], 'reasoningEffort'), false);
    f.controller.dispose();
  }
});

test('catalog removal and outage immediately gate chat and delayed older status cannot revive choices', async () => {
  for (const outage of [false, true]) {
    let delayed = false, unavailable = false, release;
    const f = controllerFixture(undefined, MODEL_IDS[0], host, {
      catalog: async payload => {
        if (unavailable && outage) throw new Error('RPC unavailable');
        return { ...stateFor(null, payload.hostId === host.id ? host : second),
          models: unavailable ? [] : MODELS, catalogRevision: unavailable ? 2 : 1 };
      },
      call: (op) => op === 'status' && delayed ? new Promise(resolve => { release = resolve; }) : stateFor(MODEL_IDS[0], host, { catalogRevision: 1 }),
    });
    f.controller.start(); await flush(); assert.equal(f.controller.getSnapshot().ready, true);
    delayed = true; const status = f.controller.poll(); await flush();
    unavailable = true; await f.controller.refreshCatalogs();
    assert.equal(f.controller.getSnapshot().ready, false); assert.ok(f.block());
    assert.equal(f.controller.getSnapshot().availableModels[host.id].length, 0);
    release(stateFor(MODEL_IDS[0], host, { catalogRevision: 1 })); await status;
    assert.equal(f.controller.getSnapshot().ready, false); assert.ok(f.block());
    assert.equal(f.controller.getSnapshot().availableModels[host.id].length, 0);
    assert.equal(f.calls.some(row => row.op === 'prepare'), false); f.controller.dispose();
  }
});

test('canonical plugin package names match backend and client-module identities', async () => {
  assert.equal(modelPluginName, 'dsh-model-switcher');
  for (const pluginName of ['dsh-model-switcher', 'dsh-delete-chat']) {
    const base = new URL(`./plugins/${pluginName}/`, import.meta.url);
    const metadata = JSON.parse(fs.readFileSync(new URL('package.json', base), 'utf8'));
    const backend = await import(new URL('index.mjs', base).href);
    let registration;
    vm.runInNewContext(fs.readFileSync(new URL('client.js', base), 'utf8'), {
      window: { __ModuleLoader__: { load(module) { registration = module; } } },
    });
    assert.equal(metadata.name, pluginName);
    assert.equal(backend.name, pluginName);
    assert.equal(registration.id, metadata.name);
    assert.equal(metadata.exports['./client'], './client.js');
    assert.equal(typeof registration.factory, 'function');
    assert.equal(typeof backend.apply, 'function');
  }
});

test('installed Harness module loader discovers both canonical plugin packages', {
  skip: !process.env.DSH_DELETE_TEST_PACKAGE_ROOT,
}, async () => {
  const registryModule = pathToFileURL(path.join(process.env.DSH_DELETE_TEST_PACKAGE_ROOT, 'dsh-client-modules/lib/index.js')).href;
  const { ClientModuleRegistry } = await import(registryModule);
  const registry = Object.create(ClientModuleRegistry.prototype);
  registry.ctx = { loader: {} }; registry.pkgMeta = new Map();
  for (const pluginName of ['dsh-model-switcher', 'dsh-delete-chat']) {
    const entry = new URL(`./plugins/${pluginName}/index.mjs`, import.meta.url);
    const metadata = registry.resolveMeta(entry.href, import.meta.url);
    assert.equal(metadata.packageName, pluginName);
    assert.equal(metadata.meta.clientPath, path.join(import.meta.dirname, 'plugins', pluginName, 'client.js'));
  }
});
