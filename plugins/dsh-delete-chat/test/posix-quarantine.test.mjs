import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { lockIdentity, payloadInventory, payloadNames, quarantinePayload, restorePayload } from '../posix-quarantine.mjs';

async function fixture(run) {
  const base = await fs.realpath(os.tmpdir());
  const root = await fs.mkdtemp(path.join(base, 'dsh-posix-quarantine-fixture-'));
  const originalDir = path.join(root, 'session'), backupRoot = path.join(root, 'backup');
  await fs.mkdir(originalDir); await fs.mkdir(backupRoot);
  await fs.writeFile(path.join(originalDir, 'session.lock'), '');
  await fs.writeFile(path.join(originalDir, 'session.v3.jsonl'), 'old generation');
  await fs.writeFile(path.join(originalDir, 'session.v4.jsonl'), 'current generation');
  const receipt = { originalDir, backupRoot, backupDir: path.join(backupRoot, 'fixture'), snapshot: {
    sourcePath: path.join(originalDir, 'session.v4.jsonl'), entries: await payloadInventory(originalDir), lockIdentity: await lockIdentity(originalDir),
  } };
  const moves = [], journal = [];
  const move = (from, to) => {
    // Fixture-only substitute. Production exclusively uses the kernel's atomic
    // RENAME_EXCL primitive; this substitute exercises transaction sequencing.
    if (fsSync.existsSync(to)) throw new Error('Fixture destination exists');
    fsSync.renameSync(from, to); moves.push([from, to]);
  };
  const deps = { move, journal: async patch => { journal.push(structuredClone(patch)); }, assertOwned() {}, sync: async () => {} };
  try { await run({ receipt, moves, journal, deps }); }
  finally {
    if (!root.startsWith(base + path.sep) || !path.basename(root).startsWith('dsh-posix-quarantine-fixture-')) throw new Error('Unsafe fixture cleanup');
    await fs.rm(root, { recursive: true });
  }
}

test('payload quarantine preserves lock inode, journals each move, and removes current generation last', () => fixture(async ({ receipt, deps, moves, journal }) => {
  const before = await lockIdentity(receipt.originalDir);
  await quarantinePayload(receipt, deps);
  assert.deepEqual(await fs.readdir(receipt.originalDir), ['session.lock']);
  assert.deepEqual(await lockIdentity(receipt.originalDir), before);
  assert.deepEqual(moves.map(([from]) => path.basename(from)), ['session.v3.jsonl', 'session.v4.jsonl']);
  assert.equal(journal.filter(row => row.pendingPayload).length, 2);
  assert.equal(journal.at(-1).pendingPayload, null);
  await restorePayload(receipt, deps);
  assert.deepEqual(moves.slice(2).map(([from]) => path.basename(from)), ['session.v4.jsonl', 'session.v3.jsonl']);
  assert.deepEqual(await payloadInventory(receipt.originalDir), receipt.snapshot.entries);
}));

test('partial move failure can restore history without replacing the lock', () => fixture(async ({ receipt, deps }) => {
  let moved = 0;
  await assert.rejects(quarantinePayload(receipt, { ...deps, move(from, to) { if (moved++ === 1) throw new Error('Injected move failure'); deps.move(from, to); } }), /Injected/);
  assert.ok(await fs.stat(receipt.snapshot.sourcePath));
  await restorePayload(receipt, deps);
  assert.deepEqual(await payloadInventory(receipt.originalDir), receipt.snapshot.entries);
  assert.deepEqual(await lockIdentity(receipt.originalDir), receipt.snapshot.lockIdentity);
}));

test('recovery directory sync failure leaves all original payloads untouched', () => fixture(async ({ receipt, deps, moves }) => {
  await assert.rejects(quarantinePayload(receipt, { ...deps, sync: async () => { throw new Error('Injected directory sync failure'); } }), /Injected directory sync/);
  assert.equal(moves.length, 0);
  assert.deepEqual(await payloadInventory(receipt.originalDir), receipt.snapshot.entries);
  await restorePayload(receipt, deps);
}));

test('journal failure after rename is recovered by inspecting both locations', () => fixture(async ({ receipt, deps }) => {
  let writes = 0;
  await assert.rejects(quarantinePayload(receipt, { ...deps, journal: async () => { if (++writes === 2) throw new Error('Injected journal failure'); } }), /Injected/);
  await restorePayload(receipt, deps);
  assert.deepEqual(await payloadInventory(receipt.originalDir), receipt.snapshot.entries);
}));

test('rollback refuses replacement payload and retains the original backup', () => fixture(async ({ receipt, deps }) => {
  await quarantinePayload(receipt, deps);
  await fs.writeFile(receipt.snapshot.sourcePath, 'new history');
  await assert.rejects(restorePayload(receipt, deps), { code: 'archived-chat-delete/restore-conflict' });
  assert.equal(await fs.readFile(receipt.snapshot.sourcePath, 'utf8'), 'new history');
  assert.equal(await fs.readFile(path.join(receipt.backupDir, 'session.v4.jsonl'), 'utf8'), 'current generation');
}));

test('changed lock inode refuses quarantine before moving any payload', () => fixture(async ({ receipt, deps, moves }) => {
  await fs.rename(path.join(receipt.originalDir, 'session.lock'), path.join(receipt.backupRoot, 'old.lock'));
  await fs.writeFile(path.join(receipt.originalDir, 'session.lock'), '');
  await assert.rejects(quarantinePayload(receipt, deps), { code: 'archived-chat-delete/lock-changed' });
  assert.equal(moves.length, 0);
}));

test('lock timestamps may change during contention without invalidating payload identity', () => fixture(async ({ receipt, deps }) => {
  await fs.writeFile(path.join(receipt.originalDir, 'session.lock'), '');
  await quarantinePayload(receipt, deps);
  await restorePayload(receipt, deps);
  assert.deepEqual(await payloadInventory(receipt.originalDir), receipt.snapshot.entries);
}));

test('noncanonical lock spelling is refused on case-insensitive filesystems', () => fixture(async ({ receipt, deps, moves }) => {
  await fs.rename(path.join(receipt.originalDir, 'session.lock'), path.join(receipt.originalDir, 'temporary.lock'));
  await fs.rename(path.join(receipt.originalDir, 'temporary.lock'), path.join(receipt.originalDir, 'SESSION.LOCK'));
  await assert.rejects(quarantinePayload(receipt, deps), { code: 'archived-chat-delete/unsafe-lock' });
  assert.equal(moves.length, 0);
}));

test('unknown payload changes and invalid names fail closed', () => fixture(async ({ receipt, deps }) => {
  assert.throws(() => payloadNames({ ...receipt.snapshot, sourcePath: path.join(receipt.originalDir, 'missing') }), { code: 'archived-chat-delete/unsafe-path' });
  await fs.writeFile(path.join(receipt.originalDir, 'unexpected'), 'other data');
  await assert.rejects(quarantinePayload(receipt, deps), { code: 'archived-chat-delete/storage-changed' });
}));
