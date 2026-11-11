import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
import { pathToFileURL } from 'node:url';
import { createDeletionService, verifyCleanupRuntime } from '../service.mjs';
import { createRpcHandler, createFetchRoute } from '../index.mjs';

function fixture(options = {}) {
  const id = 'session-fixture';
  const header = { id, version: 4, createdAt: 100, isSeeded: false, cwd: 'C:/fixture' };
  let stored = true, now = 1000, operations = [], released = false, once = false;
  const checkpoint = { identity: { createdAt: 100 }, rows: { title: { val: 'Fixture' } } };
  const projections = new Map([[id, checkpoint]]);
  const records = new Map([['workspace-fixture', { sessionIds: ['other-before', id, 'other-after'], title: 'Fixture' }]]);
  const table = {
    entries: () => records.entries(), get: key => records.get(key),
    async update(key, fn) {
      if (options.failMembership && !once) { once = true; throw new Error('injected membership write failure'); }
      const value = fn(records.get(key)); records.set(key, value); return value;
    },
  };
  const projection = { get: key => projections.get(key), async delete(key) { operations.push('checkpoint-delete'); return projections.delete(key); },
    async put(key, value) { operations.push('checkpoint-restore'); projections.set(key, value); } };
  const registry = {
    state: { archivedSessionIds: [id, 'other-archive'], pinnedSessionIds: [] },
    get archivedSessionIds() { return this.state.archivedSessionIds; },
    headers: new Map([[id, header]]), sessionPaths: new Map([[id, 'C:/fixture']]),
    missingSessionPaths: new Set(), invalidSessionPaths: new Map(), entities: new Map([['workspace-fixture', { record: records.get('workspace-fixture') }]]),
    requireState() { return this.state; }, requireTable: () => table,
    async setState(value) { this.state = value; }, async enqueueOperation(fn) { return fn(); },
  };
  const ctx = {
    workspaceRegistry: registry,
    sessions: { get: () => options.loaded ? { header } : undefined, list: () => [] }, agents: { get: () => undefined },
    sessionPersistence: { async stat() { return stored ? { header, revision: '1' } : undefined; },
      async list() { return [...(stored ? [{ header }] : []), ...(options.child ? [{ header: { id: 'child', parentSession: id } }] : [])]; } },
    sessionQuery: { _observations: { cache: new Map(options.reading ? [[id, { refs: 1 }]] : []) },
      async searchSessions() { operations.push('reconcile'); return { items: [] }; },
      async listSessions() { return stored ? [{ header }] : []; } },
    storageDomain: { get: () => ({ table: () => projection }) },
    get: name => name === 'schedule' && options.schedule ? { catalog: async () => [{ sessionId: id }] } : undefined,
    async waterfall() { return options.activity ? [{ kind: 'job' }] : []; }, logger: { warn() {} },
  };
  const adapter = {
    async verify() {}, async inspect() { return { id, revision: '1', header }; },
    async acquire(snapshot) { operations.push('acquire'); return { snapshot, released: false, receipt: null }; },
    async quarantine(lease) {
      operations.push('quarantine'); stored = false;
      const receipt = { transactionId: 'tx', backupDir: 'C:/fixture-backup', manifestPath: 'C:/fixture-backup.json', phase: 'quarantined' };
      lease.receipt = receipt;
      if (options.failAfterMove) { const error = new Error('injected manifest failure'); error.receipt = receipt; throw error; }
      if (options.childAfterMove) options.child = true;
      return receipt;
    },
    async rollback(receipt) { operations.push('rollback'); if (options.failRollback) throw new Error('injected restore failure'); stored = true; receipt.phase = 'restored'; },
    async release(lease) {
      operations.push('release');
      if (options.failRelease && !once) { once = true; throw new Error('injected release failure'); }
      released = true; lease.released = true;
    },
    async updateManifest(receipt, patch) { operations.push(`phase:${patch.phase}`); receipt.phase = patch.phase; },
  };
  const service = createDeletionService(ctx, { packageRoot: 'C:/fake-packages' }, {
    adapterFactory: async () => adapter, verifyRuntime: async () => {}, now: () => now,
  });
  return { id, header, service, ctx, operations, records, projections,
    stored: () => stored, released: () => released, tick: value => { now += value; } };
}

async function deletion(f) {
  const preview = await f.service('preview', { sessionId: f.id });
  assert.equal(preview.eligible, true);
  return f.service('delete', { sessionId: f.id, token: preview.token, confirmation: 'delete-archived-chat' });
}

test('preview is read-only and explicit confirmation is mandatory', async () => {
  const f = fixture();
  const value = await f.service('preview', { sessionId: f.id });
  assert.equal(value.eligible, true);
  assert.deepEqual(f.operations, []);
  await assert.rejects(f.service('delete', { sessionId: f.id, token: value.token }), { code: 'confirmation-expired' });
  assert.equal(f.stored(), true);
});

for (const [option, code] of [['loaded', 'loaded'], ['reading', 'history-in-use'], ['activity', 'activity'], ['schedule', 'scheduled'], ['child', 'linked-chats']]) {
  test(`refuses ${option} without storage mutation`, async () => {
    const f = fixture({ [option]: true });
    const result = await f.service('preview', { sessionId: f.id });
    assert.equal(result.eligible, false); assert.equal(result.code, code); assert.deepEqual(f.operations, []);
  });
}

test('live archive state is checked again after confirmation', async () => {
  const f = fixture(); const preview = await f.service('preview', { sessionId: f.id });
  f.ctx.workspaceRegistry.state.archivedSessionIds = [];
  await assert.rejects(f.service('delete', { sessionId: f.id, token: preview.token, confirmation: 'delete-archived-chat' }), { code: 'not-archived' });
  assert.equal(f.stored(), true);
});

test('inconsistent pinned/archive state fails closed without losing pin metadata', async () => {
  const f = fixture(); f.ctx.workspaceRegistry.state.pinnedSessionIds = ['other-pin', f.id];
  const result = await f.service('preview', { sessionId: f.id });
  assert.equal(result.eligible, false); assert.equal(result.code, 'inconsistent-archive');
  assert.deepEqual(f.ctx.workspaceRegistry.state.pinnedSessionIds, ['other-pin', f.id]);
  assert.deepEqual(f.operations, []);
});

test('expired, wrong-chat and replayed tokens cannot remove storage', async () => {
  const f = fixture(); const preview = await f.service('preview', { sessionId: f.id });
  await assert.rejects(f.service('delete', { sessionId: 'another-session', token: preview.token, confirmation: 'delete-archived-chat' }), { code: 'confirmation-expired' });
  const next = await f.service('preview', { sessionId: f.id }); f.tick(120001);
  await assert.rejects(f.service('delete', { sessionId: f.id, token: next.token, confirmation: 'delete-archived-chat' }), { code: 'confirmation-expired' });
  assert.equal(f.stored(), true);
});

test('confirmed transaction removes only target metadata and releases writer before complete', async () => {
  const f = fixture(); const result = await deletion(f);
  assert.equal(result.deleted, true); assert.equal(f.stored(), false); assert.equal(f.released(), true);
  assert.deepEqual(f.records.get('workspace-fixture').sessionIds, ['other-before', 'other-after']);
  assert.deepEqual(f.ctx.workspaceRegistry.archivedSessionIds, ['other-archive']);
  assert.equal(f.projections.has(f.id), false); assert.equal(f.ctx.workspaceRegistry.headers.has(f.id), false);
  assert.ok(f.operations.indexOf('release') < f.operations.indexOf('phase:complete'));
});

test('disabled unopened search is preserved and cleanup is explicitly deferred', async () => {
  const f = fixture(); f.ctx.sessionQuery.config = { openAt: 'never' };
  const preview = await f.service('preview', { sessionId: f.id });
  assert.equal(preview.eligible, true);
  assert.equal(preview.searchIndexCleanup, 'deferred-until-enabled');
  assert.match(preview.message, /Search history will be updated/);
  const result = await f.service('delete', { sessionId: f.id, token: preview.token, confirmation: 'delete-archived-chat' });
  assert.equal(result.deleted, true); assert.equal(result.searchIndexCleanup, 'deferred-until-enabled');
  assert.equal(f.ctx.sessionQuery.config.openAt, 'never');
  assert.equal(f.operations.includes('reconcile'), false);
});

test('disabled search with an unexpected open handle fails closed', async () => {
  const f = fixture(); f.ctx.sessionQuery.config = { openAt: 'never' }; f.ctx.sessionQuery._db = {};
  const preview = await f.service('preview', { sessionId: f.id });
  assert.equal(preview.eligible, false); assert.equal(preview.code, 'index-state-unsupported');
  assert.deepEqual(f.operations, []);
});

for (const option of ['failAfterMove', 'failMembership', 'childAfterMove', 'failRelease']) {
  test(`${option} restores physical chat and metadata before reporting failure`, async () => {
    const f = fixture({ [option]: true });
    await assert.rejects(deletion(f), { code: 'rolled-back' });
    assert.equal(f.stored(), true); assert.equal(f.released(), true);
    assert.equal(f.projections.has(f.id), true);
    assert.deepEqual(f.records.get('workspace-fixture').sessionIds, ['other-before', f.id, 'other-after']);
    assert.equal(f.ctx.workspaceRegistry.archivedSessionIds.includes(f.id), true);
    assert.ok(f.operations.includes('rollback')); assert.ok(f.operations.includes('phase:rolled-back'));
    assert.ok(!f.operations.includes('phase:complete'));
  });
}

test('failed rollback retains recovery-required state and reports manifest', async () => {
  const f = fixture({ failAfterMove: true, failRollback: true });
  await assert.rejects(deletion(f), error => error.code === 'recovery-required' && error.message.includes('fixture-backup.json'));
  assert.ok(f.operations.includes('phase:recovery-required'));
});

test('owner admission rejects before invoking deletion and exact route validates envelope', async () => {
  let invoked = false;
  const service = async () => { invoked = true; return {}; };
  const denied = await createRpcHandler(service)('delete', {}, undefined, { principal: { kind: 'guest' } });
  assert.equal(denied.ok, false); assert.equal(invoked, false);
  const route = createFetchRoute('preview', service);
  const invalid = await route.fetch(new Request('http://local/api/archived-chat-delete/preview', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ type: 'client-request', method: 'wrong', rpcId: '1', payload: {} }),
  }));
  assert.equal(invalid.status, 400); assert.equal(invoked, false);
});

test('client dialog sends no deletion on open or Cancel; confirm refreshes baseline', async () => {
  let plugin;
  const source = await fs.readFile(new URL('../client.js', import.meta.url), 'utf8');
  vm.runInNewContext(source, { window: { __ModuleLoader__: { load(value) { plugin = value.factory(name => name === 'react' ? { createElement() {} } : {}); } } }, AbortController });
  const calls = []; let refreshes = 0;
  const controller = plugin.createDialogController({ call: async (op, payload) => { calls.push(op); return op === 'preview'
    ? { eligible: true, token: 'fixture-token' } : { deleted: true, sessionId: payload.sessionId }; }, refresh: async () => { refreshes++; } });
  await controller.open('fixture', 'Fixture'); controller.close();
  assert.deepEqual(calls, ['preview']); assert.equal(controller.getSnapshot(), null);
  await controller.open('fixture', 'Fixture'); await controller.confirm();
  assert.deepEqual(calls, ['preview', 'preview', 'delete']); assert.equal(refreshes, 1);
  assert.equal(controller.getSnapshot().result.deleted, true);
});

test('client reset discards a stale host preview', async () => {
  let plugin; const source = await fs.readFile(new URL('../client.js', import.meta.url), 'utf8');
  vm.runInNewContext(source, { window: { __ModuleLoader__: { load(value) { plugin = value.factory(() => ({})); } } }, AbortController });
  let resolve; const controller = plugin.createDialogController({ call: () => new Promise(done => { resolve = done; }), refresh: async () => {} });
  const pending = controller.open('fixture', 'Fixture'); controller.reset(); resolve({ eligible: true, token: 'old-host' }); await pending;
  assert.equal(controller.getSnapshot(), null);
});

test('real installed cleanup prototypes match exact pinned package source', { skip: !process.env.DSH_DELETE_TEST_PACKAGE_ROOT }, async () => {
  const base = process.env.DSH_DELETE_TEST_PACKAGE_ROOT;
  const { WorkspaceRegistry } = await import(pathToFileURL(`${base}/dsh-workspace/lib/index.js`));
  const { SqliteSessionQueryEngine } = await import(pathToFileURL(`${base}/dsh-session-query-sqlite/lib/index.js`));
  const { SessionProjectionCache } = await import(pathToFileURL(`${base}/dsh-session-projection-cache/lib/index.js`));
  const registry = Object.create(WorkspaceRegistry.prototype);
  for (const key of ['headers', 'sessionPaths', 'invalidSessionPaths', 'entities']) registry[key] = new Map();
  registry.missingSessionPaths = new Set();
  const query = Object.create(SqliteSessionQueryEngine.prototype); query._observations = { cache: new Map() }; query.config = { openAt: 'startup' };
  const ctx = { workspaceRegistry: registry, sessionQuery: query, sessionProjectionCache: Object.create(SessionProjectionCache.prototype),
    storageDomain: { get: () => ({ table: () => ({ delete() {} }) }) } };
  await verifyCleanupRuntime(ctx, base);
  registry.enqueueOperation = () => {};
  await assert.rejects(verifyCleanupRuntime(ctx, base), { code: 'unsupported-runtime' });
});
