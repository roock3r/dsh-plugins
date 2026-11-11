/**
 * Version-bound Windows/macOS JSONL storage adapter for archived-chat deletion.
 *
 * This deliberately has no purge operation. A successful quarantine removes the
 * session from Harness' authoritative storage, retaining a recovery copy outside
 * that storage root. Workspace, projection and query cleanup belong to the caller.
 */
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { isDeepStrictEqual } from 'node:util';
import { assertLockIdentity, lockIdentity, payloadInventory, quarantinePayload, restorePayload, syncDirectory } from './posix-quarantine.mjs';

export const SUPPORTED_STORAGE_BUILDS = Object.freeze({
  '0.2.1-rc.5': '973dd78679b2661d6f492343bc22b124ae958aa597d3b36c698a2c650f909984',
  '0.2.2-rc.1': '69efef5f84dddf947032bc1425067878fa610416c8885acde2ded9b01230c9b7',
});

const CURRENT_FORMAT = 4;
const BACKUP_NAME = '.archived-chat-delete-backups';
const RUNTIME_METHODS = ['open', 'stat', 'list', 'findLog', 'locate', 'acquireLease', 'releaseHandle'];

export function storageError(code, message, cause) {
  const error = new Error(message, cause ? { cause } : undefined);
  error.code = `archived-chat-delete/${code}`;
  return error;
}

function refuse(code, message) {
  throw storageError(code, message);
}

function normalized(value) {
  return process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value);
}

function within(root, value) {
  const relative = path.relative(root, value);
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function assertId(id) {
  if (typeof id !== 'string' || id.length === 0 || id.length > 1024 || id.includes('\0')) {
    refuse('invalid-id', 'A valid session identity is required.');
  }
}

async function exists(value) {
  try { await fs.lstat(value); return true; }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}

/** Refuse links and junctions in every existing ancestor, including the target. */
async function assertPlainPath(value, expectedType) {
  const absolute = path.resolve(value);
  let cursor = absolute;
  for (;;) {
    const entry = await fs.lstat(cursor);
    if (entry.isSymbolicLink()) refuse('unsafe-path', 'Linked storage paths cannot be deleted by this adapter.');
    if (cursor === absolute && expectedType && !entry[expectedType]()) {
      refuse('unsafe-path', 'The session storage path has an unexpected file type.');
    }
    const parent = path.dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
  if (normalized(await fs.realpath(absolute)) !== normalized(absolute)) {
    refuse('unsafe-path', 'The storage path resolves to an unexpected location.');
  }
}

async function inventory(directory) {
  const result = [];
  async function visit(current) {
    const children = (await fs.readdir(current, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name));
    for (const child of children) {
      if (result.length >= 10000) refuse('too-many-files', 'This session contains too many artifacts for the deletion adapter.');
      const file = path.join(current, child.name);
      const info = await fs.lstat(file, { bigint: true });
      if (info.isSymbolicLink() || (!info.isFile() && !info.isDirectory())) {
        refuse('unsafe-path', 'Session storage contains a link or unsupported artifact.');
      }
      result.push({
        path: path.relative(directory, file), type: info.isDirectory() ? 'directory' : 'file',
        dev: String(info.dev), ino: String(info.ino), size: String(info.size),
        mtimeNs: String(info.mtimeNs), ctimeNs: String(info.ctimeNs),
      });
      if (info.isDirectory()) await visit(file);
    }
  }
  await visit(directory);
  return result;
}

/** Load the same no-replace, write-through namespace primitive used by Harness. */
function windowsMover(packageRoot) {
  let api;
  return (from, to, replace = false) => {
    if (!api) {
      const require = createRequire(path.join(packageRoot, 'package.json'));
      const library = require('koffi').load('kernel32.dll');
      api = {
        move: library.func('__stdcall', 'MoveFileExW', 'int', ['str16', 'str16', 'uint']),
        lastError: library.func('__stdcall', 'GetLastError', 'uint', []),
      };
    }
    // MOVEFILE_WRITE_THROUGH, with replacement permitted only for our manifest.
    if (api.move(path.toNamespacedPath(from), path.toNamespacedPath(to), 8 | (replace ? 1 : 0)) === 0) {
      const nativeCode = api.lastError();
      throw storageError('rename-failed', `The recovery move failed (Windows error ${nativeCode}).`);
    }
  };
}

/** Apple renamex_np(RENAME_EXCL) is atomic and refuses an existing destination.
 * Source: https://github.com/apple-oss-distributions/xnu/blob/main/bsd/sys/stdio.h
 * No fallback is permitted on a filesystem that lacks exclusive rename support.
 */
function darwinMover(packageRoot) {
  let api;
  return (from, to, replace = false) => {
    if (!api) {
      const require = createRequire(path.join(packageRoot, 'package.json'));
      const koffi = require('koffi');
      const library = koffi.load('/usr/lib/libSystem.B.dylib');
      api = { move: library.func('int renamex_np(const char *from, const char *to, unsigned int flags)'), errno: koffi.errno };
    }
    if (api.move(from, to, replace ? 0 : 4) !== 0) {
      throw storageError('rename-failed', `The recovery move failed (macOS error ${api.errno()}). No overwrite fallback was attempted.`);
    }
  };
}

async function createJson(file, value) {
  const handle = await fs.open(file, 'wx', 0o600);
  try { await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, 'utf8'); await handle.sync(); }
  finally { await handle.close(); }
}

/**
 * @param {object} ctx - Harness context with sessionPersistence, sessions, agents.
 * @param {{packageRoot:string, platform?:string}} options - Exact JSONL package root.
 */
export async function buildAdapter(ctx, { packageRoot, platform = process.platform } = {}) {
  if (typeof packageRoot !== 'string' || !path.isAbsolute(packageRoot)) {
    refuse('unsupported-build', 'The installed JSONL package path must be configured explicitly.');
  }
  if (!['win32', 'darwin'].includes(platform) || platform !== process.platform) {
    refuse('unsupported-platform', 'Archived-chat deletion requires a supported Windows or macOS Harness host.');
  }
  const persistence = ctx.sessionPersistence;
  // Cordis can return a different contextual proxy for the same service. The
  // persistence contract exposes this symbol specifically for stable identity.
  const persistenceIdentity = persistence?.identity;
  const leases = new WeakSet();
  const receipts = new WeakSet();
  const receiptLeases = new WeakMap();
  const movedReceipts = new WeakSet();
  const posix = platform === 'darwin';
  const move = posix ? darwinMover(packageRoot) : windowsMover(packageRoot);
  let build;

  async function verify() {
    const [metadataText, source] = await Promise.all([
      fs.readFile(path.join(packageRoot, 'package.json'), 'utf8'),
      fs.readFile(path.join(packageRoot, 'lib', 'index.js'), 'utf8'),
    ]);
    const metadata = JSON.parse(metadataText);
    const sha256 = createHash('sha256').update(source).digest('hex');
    if (metadata.name !== '@deepseek-ai/dsh-session-persistence-jsonl' || SUPPORTED_STORAGE_BUILDS[metadata.version] !== sha256) {
      refuse('unsupported-build', 'This Harness storage build has not been verified for chat deletion.');
    }
    if (typeof persistenceIdentity !== 'symbol' || ctx.sessionPersistence?.identity !== persistenceIdentity ||
        persistence?.name !== 'session-persistence-jsonl' ||
        typeof persistence.root !== 'string' || !path.isAbsolute(persistence.root) ||
        !(persistence.coldLogMemo instanceof Map) || !(persistence.migrationPreparations instanceof Map) ||
        !(persistence.tracker?.openHandles instanceof Set) || !(persistence.tracker?.writers instanceof Map) ||
        !(persistence.tracker?.pending instanceof Map) || typeof ctx.sessions?.get !== 'function' ||
        typeof ctx.agents?.get !== 'function') {
      refuse('unsupported-runtime', 'The running Harness storage service is unsupported or has changed.');
    }
    const prototype = Object.getPrototypeOf(persistence);
    for (const name of RUNTIME_METHODS) {
      const method = Object.getOwnPropertyDescriptor(prototype, name)?.value;
      if (Object.hasOwn(persistence, name) || typeof method !== 'function' || !source.includes(Function.prototype.toString.call(method))) {
        refuse('unsupported-runtime', 'The running storage implementation does not match the verified package.');
      }
    }
    const root = path.resolve(persistence.root);
    await assertPlainPath(root, 'isDirectory');
    build = { version: metadata.version, sha256, root, platform };
    return { ...build };
  }

  function assertCold(id, ownHandle) {
    if (ctx.sessionPersistence?.identity !== persistenceIdentity || ctx.sessions.get(id) || ctx.agents.get(id)) {
      refuse('session-loaded', 'This archived chat is still loaded. Close it and restart Harness before deleting it.');
    }
    const tracker = persistence.tracker;
    const writer = tracker.writers.get(id);
    if ((tracker.writers.has(id) && writer !== ownHandle) || tracker.pending.has(id) ||
        [...tracker.openHandles].some((handle) => handle.id === id && handle !== ownHandle) ||
        persistence.migrationPreparations.has(id)) {
      refuse('session-busy', 'This chat is being read, restored or written. Wait for that operation to finish.');
    }
    if (ownHandle && (writer !== ownHandle || !tracker.openHandles.has(ownHandle) ||
        ownHandle.access !== 'write' || ownHandle.closing || !Array.isArray(ownHandle.buffered) || ownHandle.buffered.length !== 0)) {
      refuse('ownership-changed', 'The chat storage ownership changed. Nothing was deleted.');
    }
  }

  async function inspectInternal(id, ownHandle) {
    assertId(id);
    assertCold(id, ownHandle);
    const metadata = await persistence.stat(id);
    if (!metadata) refuse('not-found', 'The archived chat is no longer in Harness storage.');
    if (metadata.formatStatus === 'migration-required' || metadata.header.version !== CURRENT_FORMAT) {
      refuse('unsupported-format', 'This chat uses an older storage format and cannot be deleted by this adapter.');
    }
    const selected = await persistence.findLog(id);
    if (!selected || selected.sourceVersion !== CURRENT_FORMAT || metadata.header.id !== id) {
      refuse('unsupported-format', 'The chat has an unsupported or ambiguous storage generation.');
    }
    const sourcePath = path.resolve(selected.sourcePath);
    const sessionDir = path.dirname(sourcePath);
    const root = path.resolve(persistence.root);
    if (root !== build.root || !within(root, sessionDir) || path.dirname(path.dirname(sessionDir)) !== root ||
        normalized(persistence.locate(metadata.header).path) !== normalized(sourcePath) ||
        !/^session\.v4\.jsonl(?:\.zstd)?$/.test(path.basename(sourcePath))) {
      refuse('unsafe-path', 'The session artifact is outside its expected storage location.');
    }
    if (metadata.location && normalized(metadata.location.path) !== normalized(sourcePath)) {
      refuse('storage-changed', 'The session storage location changed. Refresh and try again.');
    }
    await assertPlainPath(sourcePath, 'isFile');
    const entries = await (posix ? payloadInventory(sessionDir) : inventory(sessionDir));
    const kernelLock = posix ? await lockIdentity(sessionDir) : undefined;
    const directoryStat = posix ? await fs.stat(sessionDir, { bigint: true }) : undefined;
    const after = await persistence.stat(id);
    assertCold(id, ownHandle);
    if (!after || after.revision !== metadata.revision || !isDeepStrictEqual(after.header, metadata.header)) {
      refuse('storage-changed', 'The chat changed while checking it. Refresh and try again.');
    }
    return {
      id, header: structuredClone(metadata.header), revision: metadata.revision,
      sourcePath, sessionDir, root, sourceVersion: CURRENT_FORMAT, entries,
      ...(posix ? { lockIdentity: kernelLock, directoryIdentity: { dev: String(directoryStat.dev), ino: String(directoryStat.ino) } } : {}),
      adapter: { version: build.version, sha256: build.sha256 },
    };
  }

  async function inspect(id) { await verify(); return inspectInternal(id); }

  function sameSnapshot(expected, current) {
    if (!isDeepStrictEqual(expected, current)) {
      refuse('storage-changed', 'The chat changed since confirmation. Refresh and try again.');
    }
  }

  async function acquire(snapshot) {
    await verify();
    sameSnapshot(snapshot, await inspectInternal(snapshot?.id));
    let handle;
    try {
      handle = await persistence.open(snapshot.id, 'write');
      sameSnapshot(snapshot, await inspectInternal(snapshot.id, handle));
      if (!isDeepStrictEqual(handle.header, snapshot.header) || !handle.state?.materialized) {
        refuse('ownership-changed', 'The owned session differs from the confirmed chat.');
      }
      if (posix) {
        const kernelLease = handle.lease;
        if (kernelLease?.released || kernelLease?.held?.kind !== 'posix' || typeof kernelLease.held.handle?.stat !== 'function') {
          refuse('ownership-changed', 'The macOS chat lock is not held by this writer.');
        }
        const held = await kernelLease.held.handle.stat({ bigint: true });
        if (!isDeepStrictEqual({ dev: String(held.dev), ino: String(held.ino) }, snapshot.lockIdentity)) {
          refuse('lock-changed', 'The writer owns a different chat lock inode.');
        }
      }
      const lease = { snapshot, handle, released: false, receipt: null };
      leases.add(lease);
      return lease;
    } catch (error) {
      if (handle) await handle.close();
      throw error;
    }
  }

  function requireLease(lease) {
    if (!leases.has(lease) || lease.released) refuse('invalid-lease', 'The deletion lease is unavailable.');
  }

  function requireReceipt(receipt) {
    if (!receipts.has(receipt)) refuse('invalid-receipt', 'The recovery transaction is not owned by this operation.');
  }

  async function updateManifest(receipt, patch) {
    requireReceipt(receipt);
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) refuse('invalid-manifest', 'A recovery state object is required.');
    for (const key of ['transactionId', 'sessionId', 'originalDir', 'backupDir', 'backupRoot', 'manifestPath', 'snapshot', 'mode']) {
      if (Object.hasOwn(patch, key)) refuse('invalid-manifest', 'Recovery identity fields cannot be changed.');
    }
    await assertPlainPath(receipt.backupRoot, 'isDirectory');
    await assertPlainPath(receipt.manifestPath, 'isFile');
    const record = JSON.parse(await fs.readFile(receipt.manifestPath, 'utf8'));
    if (record.transactionId !== receipt.transactionId || record.sessionId !== receipt.sessionId ||
        record.originalDir !== receipt.originalDir || record.backupDir !== receipt.backupDir) {
      refuse('invalid-manifest', 'The recovery manifest no longer matches this transaction.');
    }
    const next = { ...record, ...structuredClone(patch), updatedAt: new Date().toISOString() };
    const temporary = path.join(receipt.backupRoot, `.${receipt.transactionId}.${randomUUID()}.json.tmp`);
    await createJson(temporary, next);
    try { move(temporary, receipt.manifestPath, true); }
    catch (error) { await fs.unlink(temporary).catch(() => {}); throw error; }
    if (posix) await syncDirectory(receipt.backupRoot);
    if (typeof next.phase === 'string') receipt.phase = next.phase;
    return next;
  }

  async function quarantine(lease, { manifest = {} } = {}) {
    requireLease(lease);
    if (lease.receipt) refuse('already-quarantined', 'This chat already has a recovery transaction.');
    await verify();
    sameSnapshot(lease.snapshot, await inspectInternal(lease.snapshot.id, lease.handle));
    const backupRoot = path.join(path.dirname(lease.snapshot.root), BACKUP_NAME);
    if (within(lease.snapshot.root, backupRoot) || normalized(backupRoot) === normalized(lease.snapshot.root)) {
      refuse('unsafe-path', 'The recovery directory must be outside session storage.');
    }
    try { await fs.mkdir(backupRoot, { mode: 0o700 }); }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
    // Make the recovery root's directory entry durable before any payload can
    // leave its authoritative location, including the very first deletion.
    if (posix) await syncDirectory(path.dirname(backupRoot));
    return performQuarantine(lease, backupRoot, manifest);
  }

  async function performQuarantine(lease, backupRoot, manifest) {
    await assertPlainPath(backupRoot, 'isDirectory');
    const [sourceInfo, targetInfo] = await Promise.all([
      fs.stat(lease.snapshot.sessionDir, { bigint: true }), fs.stat(backupRoot, { bigint: true }),
    ]);
    if (sourceInfo.dev !== targetInfo.dev) refuse('cross-volume', 'The recovery directory must be on the same volume as session storage.');
    const transactionId = `${Date.now()}-${randomUUID()}`;
    const receipt = {
      transactionId, sessionId: lease.snapshot.id, snapshot: lease.snapshot,
      originalDir: lease.snapshot.sessionDir, backupRoot,
      backupDir: path.join(backupRoot, transactionId),
      manifestPath: path.join(backupRoot, `${transactionId}.json`), phase: 'prepared',
      mode: posix ? 'payload-preserve-lock' : 'directory',
    };
    const record = {
      schemaVersion: 1, ...receipt, createdAt: new Date().toISOString(),
      recovery: structuredClone(manifest),
    };
    await createJson(receipt.manifestPath, record);
    receipts.add(receipt);
    receiptLeases.set(receipt, lease);
    lease.receipt = receipt;
    // The native no-replace rename and this final ownership check are synchronous.
    // No async operation may be inserted between them.
    sameSnapshot(lease.snapshot, await inspectInternal(lease.snapshot.id, lease.handle));
    assertCold(lease.snapshot.id, lease.handle);
    try {
      if (posix) {
        await quarantinePayload(receipt, { move, journal: patch => updateManifest(receipt, patch),
          assertOwned: () => assertCold(lease.snapshot.id, lease.handle) });
      } else move(receipt.originalDir, receipt.backupDir);
      movedReceipts.add(receipt);
      receipt.phase = 'quarantined';
      persistence.coldLogMemo.delete(receipt.sessionId);
      await updateManifest(receipt, { phase: 'quarantined' });
      if (await persistence.stat(receipt.sessionId) || (await persistence.list()).some((row) => row.header.id === receipt.sessionId)) {
        refuse('verification-failed', 'Harness still sees the chat after the recovery move.');
      }
      return receipt;
    } catch (error) {
      error.receipt = receipt;
      throw error;
    }
  }

  async function rollback(receipt) {
    requireReceipt(receipt);
    if (receipt.phase === 'restored') return;
    if (posix) {
      await assertPlainPath(receipt.originalDir, 'isDirectory');
      await assertLockIdentity(receipt);
      const owner = receiptLeases.get(receipt);
      let reacquired;
      const heldWriter = owner && !owner.released ? owner.handle : undefined;
      try {
        assertCold(receipt.sessionId, heldWriter);
        // The final manifest write can fail after release. Reacquire the same
        // preserved inode before moving payload back, never restore unlocked.
        if (!heldWriter) {
          reacquired = await persistence.acquireLease(receipt.sessionId, undefined, receipt.originalDir);
          const held = await reacquired.held?.handle?.stat({ bigint: true });
          if (reacquired.held?.kind !== 'posix' || !held || !isDeepStrictEqual({ dev: String(held.dev), ino: String(held.ino) }, receipt.snapshot.lockIdentity)) {
            refuse('lock-changed', 'Recovery could not own the original chat lock.');
          }
        }
        await restorePayload(receipt, { move, journal: patch => updateManifest(receipt, patch),
          assertOwned: () => assertCold(receipt.sessionId, heldWriter) });
      } finally { await reacquired?.release(); }
      movedReceipts.delete(receipt);
      persistence.coldLogMemo.delete(receipt.sessionId);
      const restored = await persistence.stat(receipt.sessionId);
      if (!restored || !isDeepStrictEqual(restored.header, receipt.snapshot.header)) refuse('restore-verification-failed', 'The restored chat did not pass verification.');
      await updateManifest(receipt, { phase: 'restored' });
      return;
    }
    const originalExists = await exists(receipt.originalDir);
    const backupExists = await exists(receipt.backupDir);
    if (originalExists && backupExists) refuse('restore-conflict', 'Both original and recovery directories exist; the backup has been retained for manual recovery.');
    if (!originalExists && !backupExists) refuse('restore-missing', 'The original and recovery directories are both missing.');
    if (backupExists) {
      await assertPlainPath(receipt.backupDir, 'isDirectory');
      await assertPlainPath(path.dirname(receipt.originalDir), 'isDirectory');
      if (!isDeepStrictEqual(await inventory(receipt.backupDir), receipt.snapshot.entries)) {
        refuse('restore-changed', 'The recovery artifacts changed after deletion. They have been retained for manual recovery.');
      }
      move(receipt.backupDir, receipt.originalDir);
    }
    movedReceipts.delete(receipt);
    persistence.coldLogMemo.delete(receipt.sessionId);
    const restored = await persistence.stat(receipt.sessionId);
    if (!restored || !isDeepStrictEqual(restored.header, receipt.snapshot.header)) {
      refuse('restore-verification-failed', 'The restored chat did not pass verification. Its recovery manifest was retained.');
    }
    await updateManifest(receipt, { phase: 'restored' });
  }

  async function release(lease) {
    if (!leases.has(lease)) refuse('invalid-lease', 'The deletion lease is unavailable.');
    if (lease.released) return;
    // Unexpected live events must never drain into a path we just quarantined.
    const storageMoved = lease.receipt && (movedReceipts.has(lease.receipt) ||
      await exists(lease.receipt.backupDir) || !await exists(lease.receipt.originalDir));
    if (storageMoved && lease.handle.buffered.length > 0) {
      try { await rollback(lease.receipt); }
      catch (error) {
        throw storageError('restart-required', 'Unexpected activity could not be restored safely. The lease remains held and the backup is retained; close Harness before manual recovery.', error);
      }
      await lease.handle.close();
      lease.released = true;
      refuse('unexpected-activity', 'New chat activity was detected; the storage move was restored.');
    }
    await lease.handle.close();
    lease.released = true;
  }

  await verify();
  return { verify, inspect, acquire, quarantine, rollback, release, updateManifest };
}
