import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { pathToFileURL } from 'node:url';
import { buildAdapter } from '../storage-adapter.mjs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const packageRoot = process.env.DSH_STORAGE_TEST_PACKAGE_ROOT;
if (!packageRoot) {
  test('real installed storage adapter fixtures', { skip: 'Set DSH_STORAGE_TEST_PACKAGE_ROOT to an installed Harness JSONL package to run these fixtures.' }, () => {});
} else {
const { Context } = await import(pathToFileURL(path.join(packageRoot, '../cordis/lib/index.js')).href);
const jsonl = await import(pathToFileURL(path.join(packageRoot, 'lib/index.js')).href);
const rejection = (code) => ({ code: `archived-chat-delete/${code}` });

/** Every test owns a real installed JSONL backend with synthetic, temporary data. */
async function fixture(run) {
  const temporaryRoot = await fs.realpath(os.tmpdir());
  const temporary = await fs.mkdtemp(path.join(temporaryRoot, 'archived-delete-adapter-fixture-'));
  const root = path.join(temporary, 'sessions');
  await fs.mkdir(root);
  const context = new Context();
  const fiber = context.plugin(jsonl, { root, compression: 'none' });
  await fiber.await();
  const persistence = context.sessionPersistence;
  const refs = { sessionPersistence: persistence, sessions: { get: () => undefined }, agents: { get: () => undefined } };
  async function create(id = 'fixture-chat') {
    const handle = await persistence.create({ id, version: 4, createdAt: 1, isSeeded: false, delegationDepth: 0 });
    await handle.flush();
    await handle.close();
    return id;
  }
  try {
    const adapter = await buildAdapter(refs, { packageRoot });
    await run({ adapter, persistence, refs, create, temporary, root });
  } finally {
    await fiber.dispose();
    const absolute = path.resolve(temporary);
    if (!absolute.startsWith(temporaryRoot + path.sep) ||
        !path.basename(absolute).startsWith('archived-delete-adapter-fixture-')) throw new Error('Unsafe fixture cleanup');
    await fs.rm(absolute, { recursive: true });
  }
}

test('verified installed runtime supports a cold current-format session', () => fixture(async ({ adapter, create }) => {
  await create();
  const snapshot = await adapter.inspect('fixture-chat');
  assert.equal(snapshot.header.version, 4);
  assert.equal(snapshot.entries.length, 1);
  assert.match((await adapter.verify()).version, /^0\.2\./);
}));

test('unsupported platforms and invalid identities fail before any move', () => fixture(async ({ adapter, refs, persistence }) => {
  await assert.rejects(buildAdapter(refs, { packageRoot, platform: 'linux' }), rejection('unsupported-platform'));
  await assert.rejects(adapter.inspect(''), rejection('invalid-id'));
  await assert.rejects(adapter.inspect('../not-an-existing-chat'), rejection('not-found'));
  assert.deepEqual(await persistence.list(), []);
}));

test('loaded sessions and existing readers prevent deletion', () => fixture(async ({ adapter, persistence, refs, create }) => {
  const id = await create();
  refs.sessions.get = () => ({ id });
  await assert.rejects(adapter.inspect(id), rejection('session-loaded'));
  refs.sessions.get = () => undefined;
  const reader = await persistence.open(id, 'read');
  try { await assert.rejects(adapter.inspect(id), rejection('session-busy')); }
  finally { await reader.close(); }
  assert.ok(await persistence.stat(id));
}));

test('a stale confirmation cannot acquire a deletion lease', () => fixture(async ({ adapter, create }) => {
  const id = await create();
  const stale = await adapter.inspect(id);
  await fs.utimes(stale.sourcePath, new Date(), new Date());
  await assert.rejects(adapter.acquire(stale), rejection('storage-changed'));
}));

test('a reader opened after lease acquisition prevents the storage move', () => fixture(async ({ adapter, persistence, create }) => {
  const id = await create();
  const lease = await adapter.acquire(await adapter.inspect(id));
  const reader = await persistence.open(id, 'read');
  try {
    await assert.rejects(adapter.quarantine(lease), rejection('session-busy'));
    assert.equal(lease.receipt, null);
    assert.ok(await persistence.stat(id));
  } finally {
    await reader.close();
    await adapter.release(lease);
  }
}));

test('quarantine removes the authoritative directory and retains recovery data', () => fixture(async ({ adapter, persistence, create }) => {
  const id = await create();
  const lease = await adapter.acquire(await adapter.inspect(id));
  try {
    await assert.rejects(adapter.inspect(id), rejection('session-busy'));
    const receipt = await adapter.quarantine(lease, { manifest: { projection: { test: 1 } } });
    assert.equal(await persistence.stat(id), undefined);
    assert.deepEqual(await persistence.list(), []);
    assert.ok((await fs.stat(receipt.backupDir)).isDirectory());
    await assert.rejects(adapter.updateManifest(receipt, { originalDir: 'C:\\' }), rejection('invalid-manifest'));
    await adapter.updateManifest(receipt, { phase: 'complete' });
    assert.equal(JSON.parse(await fs.readFile(receipt.manifestPath, 'utf8')).recovery.projection.test, 1);
    await adapter.rollback(receipt);
    assert.ok(await persistence.stat(id));
    assert.equal(receipt.phase, 'restored');
  } finally { await adapter.release(lease); }
}));

test('repeated transactions reuse the backup root and close without recreation', () => fixture(async ({ adapter, persistence, create }) => {
  for (const id of ['first', 'second']) {
    await create(id);
    const lease = await adapter.acquire(await adapter.inspect(id));
    await adapter.quarantine(lease);
    await adapter.release(lease);
    assert.equal(await persistence.stat(id), undefined);
  }
}));

test('rollback never overwrites replacement history', () => fixture(async ({ adapter, create }) => {
  const id = await create();
  const lease = await adapter.acquire(await adapter.inspect(id));
  const receipt = await adapter.quarantine(lease);
  await adapter.release(lease);
  if (process.platform === 'darwin') await fs.writeFile(receipt.snapshot.sourcePath, 'replacement fixture');
  else await fs.mkdir(receipt.originalDir);
  await assert.rejects(adapter.rollback(receipt), rejection('restore-conflict'));
  assert.ok((await fs.stat(receipt.backupDir)).isDirectory());
  if (process.platform === 'darwin') await fs.unlink(receipt.snapshot.sourcePath);
  else await fs.rmdir(receipt.originalDir);
  await adapter.rollback(receipt);
}));

test('macOS keeps the lock inode and rejects a separate writer throughout quarantine', { skip: process.platform !== 'darwin' }, () => fixture(async ({ adapter, persistence, create, root }) => {
  const id = await create();
  const snapshot = await adapter.inspect(id);
  const before = await fs.stat(path.join(snapshot.sessionDir, 'session.lock'), { bigint: true });
  const lease = await adapter.acquire(snapshot);
  const probeSource = action => `
    const { Context } = await import(${JSON.stringify(pathToFileURL(path.join(packageRoot, '../cordis/lib/index.js')).href)});
    const jsonl = await import(${JSON.stringify(pathToFileURL(path.join(packageRoot, 'lib/index.js')).href)});
    const ctx = new Context(); const fiber = ctx.plugin(jsonl, { root: ${JSON.stringify(root)}, compression: 'none' });
    await fiber.await();
    let rejected = false;
    try {
      try { const unexpected = await ${action}; await unexpected.close?.(); await unexpected.release?.(); }
      catch(error) { if (error.name !== 'SessionAlreadyOwnedError') throw error; rejected = true; }
      if (!rejected) throw new Error('The second process unexpectedly acquired the lock');
    }
    finally { await fiber.dispose(); }
  `;
  const probe = action => promisify(execFile)(process.execPath, ['--input-type=module', '-e', probeSource(action)], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } });
  try {
    await probe(`ctx.sessionPersistence.open(${JSON.stringify(id)}, 'write')`);
    const receipt = await adapter.quarantine(lease);
    assert.deepEqual(await fs.readdir(snapshot.sessionDir), ['session.lock']);
    await probe(`ctx.sessionPersistence.acquireLease(${JSON.stringify(id)}, undefined, ${JSON.stringify(snapshot.sessionDir)})`);
    await adapter.release(lease);
    const after = await fs.stat(path.join(snapshot.sessionDir, 'session.lock'), { bigint: true });
    assert.equal(after.dev, before.dev); assert.equal(after.ino, before.ino);
    await assert.rejects(persistence.open(id, 'write'), /not found|not exist/i);
    assert.deepEqual(await persistence.list(), []);
    // Restoration after writer release must reacquire the preserved lock inode.
    await adapter.rollback(receipt);
    assert.ok(await persistence.stat(id));
  } finally { await adapter.release(lease); }
}));

test('junctions in the storage path fail closed', () => fixture(async ({ adapter, create, temporary }) => {
  const id = await create();
  const snapshot = await adapter.inspect(id);
  const relocated = path.join(temporary, 'linked-artifacts');
  await fs.rename(snapshot.sessionDir, relocated);
  await fs.symlink(relocated, snapshot.sessionDir, 'junction');
  await assert.rejects(adapter.inspect(id), rejection('unsafe-path'));
}));

test('runtime implementation shadowing is rejected', () => fixture(async ({ adapter, persistence }) => {
  const original = persistence.stat;
  Object.defineProperty(persistence, 'stat', { configurable: true, value: original });
  try { await assert.rejects(adapter.verify(), rejection('unsupported-runtime')); }
  finally { delete persistence.stat; }
}));

test('historical generations are refused without publishing a migrated log', () => fixture(async ({ adapter, create }) => {
  const id = await create();
  const snapshot = await adapter.inspect(id);
  const header = JSON.parse((await fs.readFile(snapshot.sourcePath, 'utf8')).trim());
  header.version = 3;
  const historical = snapshot.sourcePath.replace('session.v4.', 'session.v3.');
  await fs.writeFile(historical, `${JSON.stringify(header)}\n`);
  await fs.unlink(snapshot.sourcePath);
  await assert.rejects(adapter.inspect(id), rejection('unsupported-format'));
  await assert.rejects(fs.stat(snapshot.sourcePath), { code: 'ENOENT' });
  assert.ok(await fs.stat(historical));
}));

test('an unrecognized storage source hash is rejected', () => fixture(async ({ refs, temporary }) => {
  const altered = path.join(temporary, 'altered-package');
  await fs.mkdir(path.join(altered, 'lib'), { recursive: true });
  await fs.copyFile(path.join(packageRoot, 'package.json'), path.join(altered, 'package.json'));
  await fs.writeFile(path.join(altered, 'lib/index.js'), `${await fs.readFile(path.join(packageRoot, 'lib/index.js'), 'utf8')}\n`);
  await assert.rejects(buildAdapter(refs, { packageRoot: altered }), rejection('unsupported-build'));
}));
}
