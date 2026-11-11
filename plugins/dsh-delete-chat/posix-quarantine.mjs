/**
 * macOS moves session payloads while leaving the directory and flock inode in place.
 * The supplied synchronous mover must provide atomic, no-replace rename semantics.
 * A journal is durable before each namespace change; no copy/unlink fallback exists.
 */
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';

export const LOCK_NAME = 'session.lock';
const failure = (code, message) => Object.assign(new Error(message), { code: `archived-chat-delete/${code}` });

export function payloadNames(snapshot) {
  const names = snapshot.entries.filter(entry => !entry.path.includes(path.sep)).map(entry => entry.path);
  const current = path.basename(snapshot.sourcePath);
  if (!names.includes(current) || names.includes(LOCK_NAME) || names.some(name => !name || name === '.' || name === '..' || name.includes('/') || name.includes('\\'))) {
    throw failure('unsafe-path', 'The recovery payload does not have a valid current log.');
  }
  // Keep the current generation authoritative until all older generations are gone.
  return [...names.filter(name => name !== current), current];
}

/** Portable identity excludes ctime, which an ordinary POSIX rename changes. */
export async function payloadInventory(directory) {
  const result = [];
  async function visit(current) {
    for (const child of (await fs.readdir(current, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      if (current === directory && child.name === LOCK_NAME) continue;
      if (result.length >= 10000) throw failure('too-many-files', 'This session contains too many recovery artifacts.');
      const file = path.join(current, child.name), info = await fs.lstat(file, { bigint: true });
      if (info.isSymbolicLink() || (!info.isDirectory() && !info.isFile())) throw failure('unsafe-path', 'Session recovery contains a linked or unsupported artifact.');
      result.push({ path: path.relative(directory, file), type: info.isDirectory() ? 'directory' : 'file',
        dev: String(info.dev), ino: String(info.ino), size: String(info.size), mtimeNs: String(info.mtimeNs) });
      if (info.isDirectory()) await visit(file);
    }
  }
  await visit(directory);
  return result;
}

export async function lockIdentity(directory) {
  // On case-insensitive APFS, lstat('session.lock') can resolve 'SESSION.LOCK'.
  // Require the exact directory spelling so payload enumeration cannot move it.
  const names = await fs.readdir(directory);
  if (!names.includes(LOCK_NAME) || names.some(name => name !== LOCK_NAME && name.toLowerCase() === LOCK_NAME)) {
    throw failure('unsafe-lock', 'The chat lock name is not canonical. Automatic deletion is disabled.');
  }
  const info = await fs.lstat(path.join(directory, LOCK_NAME), { bigint: true });
  if (!info.isFile() || info.isSymbolicLink() || info.size !== 0n) throw failure('unsafe-lock', 'The chat lock must be a regular empty file.');
  return { dev: String(info.dev), ino: String(info.ino) };
}

export async function assertLockIdentity(receipt) {
  if (receipt.snapshot.directoryIdentity) {
    const directory = await fs.lstat(receipt.originalDir, { bigint: true });
    if (!directory.isDirectory() || directory.isSymbolicLink() || !isDeepStrictEqual({ dev: String(directory.dev), ino: String(directory.ino) }, receipt.snapshot.directoryIdentity)) {
      throw failure('lock-changed', 'The chat directory identity changed. Automatic recovery is disabled.');
    }
  }
  if (!isDeepStrictEqual(await lockIdentity(receipt.originalDir), receipt.snapshot.lockIdentity)) {
    throw failure('lock-changed', 'The chat lock identity changed. Keep its recovery manifest and restart Harness.');
  }
}

export async function syncDirectory(directory) {
  const handle = await fs.open(directory, 'r');
  try { await handle.sync(); } finally { await handle.close(); }
}

const forName = (entries, name) => entries.filter(entry => entry.path === name || entry.path.startsWith(`${name}${path.sep}`));
async function fileExists(file) {
  try { await fs.lstat(file); return true; }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}

/** Inspect both locations rather than trusting an interrupted journal's last line. */
async function locations(receipt) {
  const source = await payloadInventory(receipt.originalDir);
  const backup = await payloadInventory(receipt.backupDir);
  const planned = payloadNames(receipt.snapshot);
  const admitted = new Set(planned);
  for (const entry of [...source, ...backup]) {
    if (!admitted.has(entry.path.split(path.sep)[0])) throw failure('restore-conflict', 'Unexpected session artifacts exist; recovery will not overwrite or merge them.');
  }
  const missing = [];
  for (const name of planned) {
    const old = forName(source, name), saved = forName(backup, name), expected = forName(receipt.snapshot.entries, name);
    if (old.length && saved.length) throw failure('restore-conflict', 'An original artifact and its backup both exist. Neither was overwritten.');
    if (!old.length && !saved.length) throw failure('restore-missing', 'A recovery artifact is missing. The manifest was retained.');
    if (!isDeepStrictEqual(old.length ? old : saved, expected)) throw failure('restore-changed', 'The recovery artifacts changed; automatic restoration is disabled.');
    if (saved.length) missing.push(name);
  }
  return missing;
}

export async function quarantinePayload(receipt, { move, journal, assertOwned, sync = syncDirectory }) {
  await assertLockIdentity(receipt);
  if (!isDeepStrictEqual(await payloadInventory(receipt.originalDir), receipt.snapshot.entries)) throw failure('storage-changed', 'The chat changed before its recovery move.');
  await fs.mkdir(receipt.backupDir, { mode: 0o700 });
  await sync(receipt.backupRoot);
  receipt.payloadNames = payloadNames(receipt.snapshot);
  receipt.movedPayload = [];
  for (const name of receipt.payloadNames) {
    await journal({ phase: 'moving-payload', payloadNames: receipt.payloadNames, movedPayload: receipt.movedPayload, pendingPayload: name });
    await assertLockIdentity(receipt);
    assertOwned();
    // Do not yield between the final in-process ownership check and this rename.
    move(path.join(receipt.originalDir, name), path.join(receipt.backupDir, name));
    receipt.movedPayload.push(name);
    await sync(receipt.originalDir); await sync(receipt.backupDir);
    await journal({ phase: 'moving-payload', movedPayload: receipt.movedPayload, pendingPayload: null });
  }
  await assertLockIdentity(receipt);
  if ((await payloadInventory(receipt.originalDir)).length || !isDeepStrictEqual(await payloadInventory(receipt.backupDir), receipt.snapshot.entries)) {
    throw failure('verification-failed', 'The chat recovery move did not pass verification.');
  }
}

/** Caller holds the original inode's exclusive lease throughout restoration. */
export async function restorePayload(receipt, { move, journal, assertOwned, sync = syncDirectory }) {
  await assertLockIdentity(receipt);
  if (!await fileExists(receipt.backupDir)) {
    if (isDeepStrictEqual(await payloadInventory(receipt.originalDir), receipt.snapshot.entries)) return;
    throw failure('restore-missing', 'The recovery directory is missing.');
  }
  const pending = await locations(receipt);
  const current = path.basename(receipt.snapshot.sourcePath);
  // Never expose an older generation before the selected current generation.
  const restoreOrder = [current, ...payloadNames(receipt.snapshot).filter(name => name !== current)].filter(name => pending.includes(name));
  for (const name of restoreOrder) {
    await journal({ phase: 'restoring-payload', pendingRestore: name });
    await assertLockIdentity(receipt);
    assertOwned();
    move(path.join(receipt.backupDir, name), path.join(receipt.originalDir, name));
    await sync(receipt.originalDir); await sync(receipt.backupDir);
    await journal({ phase: 'restoring-payload', pendingRestore: null });
  }
  await assertLockIdentity(receipt);
  if (!isDeepStrictEqual(await payloadInventory(receipt.originalDir), receipt.snapshot.entries) || (await payloadInventory(receipt.backupDir)).length) {
    throw failure('restore-verification-failed', 'Restored chat artifacts did not pass verification.');
  }
}
