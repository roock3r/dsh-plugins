/** Real installed Harness services, isolated synthetic temporary chat. */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { pathToFileURL } from 'node:url';
import { createDeletionService } from '../service.mjs';

const packageRoot = process.env.DSH_DELETE_TEST_PACKAGE_ROOT;
const load = name => import(pathToFileURL(path.join(packageRoot, name, 'lib', 'index.js')).href);
const Context = packageRoot ? (await load('cordis')).Context : undefined;

for (const deferred of [false, true]) test(deferred
  ? 'disabled index stays unopened during deletion and later enabled search removes its stale row'
  : 'real coordinator removes synthetic chat from JSONL, checkpoint, workspace and SQLite together', { skip: !packageRoot }, async () => {
  const temporaryParent = await fs.realpath(os.tmpdir());
  const temporary = await fs.mkdtemp(path.join(temporaryParent, 'archived-delete-integration-'));
  const root = path.join(temporary, 'sessions');
  const cwd = path.join(temporary, 'workspace');
  await fs.mkdir(root); await fs.mkdir(cwd);
  const ctx = new Context(); const fibers = [];
  async function mount(name, config) {
    const module = await load(name);
    const fiber = ctx.plugin(module.default || module, config);
    fibers.push(fiber); await fiber.await(); return fiber;
  }
  try {
    await mount('dsh-storage');
    await mount('dsh-storage-json', { root: path.join(temporary, 'domains') });
    await mount('dsh-storage-domain', { backend: 'json' });
    await mount('dsh-session');
    await mount('dsh-session-projection');
    await mount('dsh-agent');
    await mount('dsh-session-persistence-jsonl', { root, compression: 'none' });
    await mount('dsh-session-projection-cache', { writeEveryEvents: 100, writeIntervalMs: 60000 });
    const queryPath = path.join(temporary, 'query.sqlite');
    let queryFiber = await mount('dsh-session-query-sqlite', { path: queryPath, openAt: 'startup' });
    await mount('dsh-workspace');
    const id = 'session-delete-integration-fixture';
    const handle = await ctx.sessionPersistence.create({ id, version: 4, createdAt: 100, isSeeded: false, cwd, delegationDepth: 0 });
    await handle.flush(); await handle.close();
    const workspace = await ctx.workspaceRegistry.create(cwd, 'Synthetic fixture');
    await workspace.attachSession(id); await ctx.workspaceRegistry.archiveSession(id);
    const checkpoints = ctx.storageDomain.get('session_projcache').table('sessions');
    await checkpoints.put(id, { identity: { formatVersion: 4, createdAt: 100, cwd, isSeeded: false, inheritedEventCount: 0 }, rows: {} });
    await ctx.sessionQuery.searchSessions({ query: 'synthetic', limit: 1 });
    assert.equal(ctx.sessionQuery._db.prepare('SELECT count(*) AS n FROM persisted_sessions WHERE id = ?').get(id).n, 1);
    let disabledIndexBytes;
    if (deferred) {
      await queryFiber.dispose();
      queryFiber = await mount('dsh-session-query-sqlite', { path: queryPath, openAt: 'never' });
      assert.equal(ctx.sessionQuery._db, undefined); assert.equal(ctx.sessionQuery._ready, undefined);
      disabledIndexBytes = await fs.readFile(queryPath);
    }
    const service = createDeletionService(ctx, { packageRoot });
    const preview = await service('preview', { sessionId: id });
    assert.equal(preview.eligible, true, JSON.stringify(preview));
    assert.equal(preview.searchIndexCleanup, deferred ? 'deferred-until-enabled' : 'reconciled');
    const result = await service('delete', { sessionId: id, token: preview.token, confirmation: 'delete-archived-chat' });
    assert.equal(result.deleted, true);
    assert.equal(await ctx.sessionPersistence.stat(id), undefined);
    assert.equal(checkpoints.get(id), undefined);
    assert.equal(workspace.sessionIds.includes(id), false);
    assert.equal(ctx.workspaceRegistry.archivedSessionIds.includes(id), false);
    assert.equal(ctx.workspaceRegistry.headers.has(id), false);
    if (deferred) {
      assert.equal(result.searchIndexCleanup, 'deferred-until-enabled');
      assert.equal(ctx.sessionQuery.config.openAt, 'never');
      assert.equal(ctx.sessionQuery._db, undefined); assert.equal(ctx.sessionQuery._ready, undefined);
      assert.deepEqual(await fs.readFile(queryPath), disabledIndexBytes, 'disabled index bytes remain untouched');
      const manifest = JSON.parse(await fs.readFile(`${result.backupPath}.json`, 'utf8'));
      assert.equal(manifest.searchIndexCleanup, 'deferred-until-enabled');
      await queryFiber.dispose();
      queryFiber = await mount('dsh-session-query-sqlite', { path: queryPath, openAt: 'startup' });
      assert.equal(ctx.sessionQuery._db.prepare('SELECT count(*) AS n FROM persisted_sessions WHERE id = ?').get(id).n, 1,
        'old index row persists until the first enabled search');
      const search = await ctx.sessionQuery.searchSessions({ query: 'synthetic', limit: 1 });
      assert.deepEqual(search.items, []);
    }
    assert.equal(ctx.sessionQuery._db.prepare('SELECT count(*) AS n FROM persisted_sessions WHERE id = ?').get(id).n, 0);
    assert.ok((await fs.stat(result.backupPath)).isDirectory());
    assert.ok((await fs.stat(cwd)).isDirectory(), 'workspace files remain');
  } finally {
    for (const fiber of fibers.reverse()) await fiber.dispose();
    const absolute = path.resolve(temporary);
    if (path.dirname(absolute) !== temporaryParent || !path.basename(absolute).startsWith('archived-delete-integration-')) throw new Error('Unsafe fixture cleanup');
    await fs.rm(absolute, { recursive: true });
  }
});
