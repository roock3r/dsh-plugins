/** Native install preflight: synthetic chat storage only; never load a user profile. */
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { createDeletionService } from './service.mjs';
import { buildAdapter } from './storage-adapter.mjs';

export async function runNativeSelfTest(packageRoot) {
  assert.ok(typeof packageRoot === 'string' && path.isAbsolute(packageRoot), 'Set DSH_DELETE_TEST_PACKAGE_ROOT to the installed @deepseek-ai directory.');
  assert.ok(['darwin', 'win32'].includes(process.platform), 'Native archive checks require macOS or Windows.');
  const load = name => import(pathToFileURL(path.join(packageRoot, name, 'lib/index.js')).href);
  const { Context } = await load('cordis');
  const temporaryParent = await fs.realpath(os.tmpdir());
  let checks = 0;

  async function fixture(action) {
    const temporary = await fs.mkdtemp(path.join(temporaryParent, 'dsh-archive-self-test-'));
    const root = path.join(temporary, 'sessions');
    const cwd = path.join(temporary, 'workspace');
    await fs.mkdir(root); await fs.mkdir(cwd);
    await fs.writeFile(path.join(cwd, 'keep.txt'), 'synthetic project file');
    const ctx = new Context(), fibers = [];
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
      const queryFiber = await mount('dsh-session-query-sqlite', { path: queryPath, openAt: 'startup' });
      await mount('dsh-workspace');
      const id = `archive-self-test-${randomUUID()}`;
      const handle = await ctx.sessionPersistence.create({ id, version: 4, createdAt: 100, isSeeded: false, cwd, delegationDepth: 0 });
      await handle.flush(); await handle.close();
      const workspace = await ctx.workspaceRegistry.create(cwd, 'Temporary installer check');
      await workspace.attachSession(id); await ctx.workspaceRegistry.archiveSession(id);
      const checkpoints = ctx.storageDomain.get('session_projcache').table('sessions');
      await checkpoints.put(id, { identity: { formatVersion: 4, createdAt: 100, cwd, isSeeded: false, inheritedEventCount: 0 }, rows: {} });
      const artifact = await ctx.sessionPersistence.findLog(id);
      const sessionDir = path.dirname(artifact.sourcePath);
      const lockPath = path.join(sessionDir, 'session.lock');
      const lockBefore = process.platform === 'darwin' ? await fs.stat(lockPath, { bigint: true }) : null;
      await action({ ctx, id, root, cwd, checkpoints, workspace, queryPath, queryFiber, mount, sessionDir, lockPath, lockBefore });
      assert.equal(await fs.readFile(path.join(cwd, 'keep.txt'), 'utf8'), 'synthetic project file');
      checks++;
    } finally {
      for (const fiber of fibers.reverse()) await fiber.dispose();
      const absolute = await fs.realpath(temporary);
      assert.equal(path.dirname(absolute), temporaryParent, 'Unsafe synthetic fixture cleanup');
      assert.ok(path.basename(absolute).startsWith('dsh-archive-self-test-'), 'Unsafe synthetic fixture name');
      await fs.rm(absolute, { recursive: true });
    }
  }

  for (const deferred of [false, true]) await fixture(async ({ ctx, id, checkpoints, workspace, queryPath, queryFiber, mount, sessionDir, lockPath, lockBefore }) => {
    await ctx.sessionQuery.searchSessions({ query: 'synthetic', limit: 1 });
    assert.equal(ctx.sessionQuery._db.prepare('SELECT count(*) AS n FROM persisted_sessions WHERE id = ?').get(id).n, 1);
    let disabledBytes, disabledFiber;
    if (deferred) {
      await queryFiber.dispose();
      disabledFiber = await mount('dsh-session-query-sqlite', { path: queryPath, openAt: 'never' });
      disabledBytes = await fs.readFile(queryPath);
    }
    const service = createDeletionService(ctx, { packageRoot });
    const preview = await service('preview', { sessionId: id });
    assert.equal(preview.eligible, true, preview.message);
    const result = await service('delete', { sessionId: id, token: preview.token, confirmation: 'delete-archived-chat' });
    assert.equal(result.deleted, true);
    assert.equal(await ctx.sessionPersistence.stat(id), undefined);
    assert.equal(checkpoints.get(id), undefined);
    assert.equal(workspace.sessionIds.includes(id), false);
    assert.equal(ctx.workspaceRegistry.archivedSessionIds.includes(id), false);
    assert.ok((await fs.stat(result.backupPath)).isDirectory());
    if (process.platform === 'darwin') {
      const after = await fs.stat(lockPath, { bigint: true });
      assert.equal(after.ino, lockBefore.ino, 'The authoritative lock inode must survive deletion.');
      assert.equal(after.dev, lockBefore.dev);
      assert.deepEqual(await fs.readdir(sessionDir), ['session.lock']);
    }
    if (deferred) {
      assert.equal(ctx.sessionQuery._db, undefined); assert.equal(ctx.sessionQuery._ready, undefined);
      assert.deepEqual(await fs.readFile(queryPath), disabledBytes);
      await disabledFiber.dispose();
      await mount('dsh-session-query-sqlite', { path: queryPath, openAt: 'startup' });
      const search = await ctx.sessionQuery.searchSessions({ query: 'synthetic', limit: 1 });
      assert.deepEqual(search.items, []);
    }
    assert.equal(ctx.sessionQuery._db.prepare('SELECT count(*) AS n FROM persisted_sessions WHERE id = ?').get(id).n, 0);
  });

  await fixture(async ({ ctx, id, root, sessionDir, lockPath, lockBefore }) => {
    const adapter = await buildAdapter(ctx, { packageRoot: path.join(packageRoot, 'dsh-session-persistence-jsonl') });
    const snapshot = await adapter.inspect(id);
    const lease = await adapter.acquire(snapshot);
    const verifyContenderBlocked = () => {
      if (process.platform !== 'darwin') return;
      const worker = `
        const {Context} = await import(${JSON.stringify(pathToFileURL(path.join(packageRoot, 'cordis/lib/index.js')).href)});
        const jsonl = await import(${JSON.stringify(pathToFileURL(path.join(packageRoot, 'dsh-session-persistence-jsonl/lib/index.js')).href)});
        const context = new Context();
        const fiber = context.plugin(jsonl, {root:${JSON.stringify(root)},compression:'none'});
        await fiber.await();
        let refused = false;
        try {
          try {
            const lease = await context.sessionPersistence.acquireLease(${JSON.stringify(id)},undefined,${JSON.stringify(sessionDir)});
            await lease.release();
          } catch(error) { if(error.name !== 'SessionAlreadyOwnedError') throw error; refused = true; }
          if(!refused) throw new Error('A second process acquired the original chat lock');
        } finally { await fiber.dispose(); }
        console.log(JSON.stringify({refused}));
      `;
      const output = execFileSync(process.execPath, ['--input-type=module', '-e', worker], {
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, encoding: 'utf8', timeout: 10000,
        windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
      });
      assert.equal(JSON.parse(output.trim().split('\n').at(-1)).refused, true);
      checks++;
    };
    let receipt;
    try {
      verifyContenderBlocked();
      receipt = await adapter.quarantine(lease, { manifest: { synthetic: true } });
      assert.equal(await ctx.sessionPersistence.stat(id), undefined);
      verifyContenderBlocked();
      if (process.platform === 'darwin') {
        const after = await fs.stat(lockPath, { bigint: true });
        assert.equal(after.ino, lockBefore.ino); assert.equal(after.dev, lockBefore.dev);
      }
      await adapter.rollback(receipt);
      assert.equal((await ctx.sessionPersistence.stat(id)).header.id, id);
      assert.ok((await fs.stat(sessionDir)).isDirectory());
    } finally {
      if (receipt && !(await ctx.sessionPersistence.stat(id))) await adapter.rollback(receipt);
      await adapter.release(lease);
    }
  });
  return { ok: true, checks, platform: process.platform };
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  try { console.log(JSON.stringify(await runNativeSelfTest(process.env.DSH_DELETE_TEST_PACKAGE_ROOT))); }
  catch (error) { console.error(`Archive preflight failed: ${error.message}`); process.exitCode = 1; }
}
