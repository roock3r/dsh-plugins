/** Archived-chat removal coordinator. Only confirmed, cold Windows sessions qualify. */
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { buildAdapter } from './storage-adapter.mjs';

const HASHES = {
  'dsh-workspace': '931ca0cb10c5102066c7723690a887f0e6e8e7ab0ffdee1a782686745b0b934f',
  'dsh-session-query': '76ce2944e561c12f48b5e240d68cafe54ce6d667b1d20722e6939ed834489939',
  'dsh-session-query-sqlite': 'dbecf83320e10d93d735b3d01384ab817a0b90102ccecb0a22c013c71dfe70a0',
  'dsh-session-projection-cache': 'faf307dce5db2fb7ff58b4c7d9e544fc7cad5de2f270a89326a8d7bb2bda9c80',
};

export class DeletionRefusal extends Error {
  constructor(code, message) { super(message); this.code = code; }
}
export const safeFailure = error => error instanceof DeletionRefusal ||
  (typeof error?.code === 'string' && error.code.startsWith('archived-chat-delete/'));
const refuse = (code, message) => { throw new DeletionRefusal(code, message); };
export const validId = id => typeof id === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,180}$/.test(id);
const digest = value => createHash('sha256').update(value).digest('hex');
const copy = value => value === undefined ? undefined : structuredClone(value);

/** A disabled index must remain unopened; its next enabled search reconciles first. */
export function searchIndexCleanupMode(query) {
  if (query.config?.openAt === 'never') {
    if (query._db !== undefined || query._ready !== undefined) {
      refuse('index-state-unsupported', 'The disabled history service has an open database. Restart Harness before deleting a chat.');
    }
    return 'deferred-until-enabled';
  }
  return 'reconciled';
}

/** The files are pinned because cleanup touches private runtime caches. */
export async function verifyCleanupRuntime(ctx, packageRoot) {
  if (typeof packageRoot !== 'string' || !path.isAbsolute(packageRoot)) {
    refuse('not-configured', 'The host administrator must configure this plugin for the installed Harness build.');
  }
  for (const [name, expected] of Object.entries(HASHES)) {
    let source;
    try { source = await fs.readFile(path.join(packageRoot, name, 'lib', 'index.js'), 'utf8'); }
    catch { refuse('unsupported-version', 'This Harness installation is not supported by the archived-chat adapter.'); }
    if (digest(source) !== expected) refuse('unsupported-version', 'Harness changed since this adapter was verified. Deletion is disabled until the adapter is reviewed.');
    // The configured source must also describe the running service, not just an unrelated install.
    const runtime = name === 'dsh-workspace' ? ctx.workspaceRegistry
      : name === 'dsh-session-projection-cache' ? ctx.sessionProjectionCache : ctx.sessionQuery;
    const method = name === 'dsh-workspace' ? 'enqueueOperation'
      : name === 'dsh-session-projection-cache' ? 'recordFor'
      : name === 'dsh-session-query' ? 'observeSession' : '_reconcile';
    let proto = Object.getPrototypeOf(runtime), found;
    while (proto && !found) { found = Object.getOwnPropertyDescriptor(proto, method)?.value; proto = Object.getPrototypeOf(proto); }
    if (Object.hasOwn(runtime, method) || typeof found !== 'function' || !source.includes(Function.prototype.toString.call(found))) {
      refuse('unsupported-runtime', 'The running Harness services do not match the configured installation.');
    }
  }
  const registry = ctx.workspaceRegistry;
  for (const key of ['headers', 'sessionPaths', 'invalidSessionPaths', 'entities']) {
    if (!(registry[key] instanceof Map)) refuse('unsupported-runtime', 'The workspace runtime is unsupported.');
  }
  if (!(registry.missingSessionPaths instanceof Set) || typeof registry.enqueueOperation !== 'function' ||
      typeof registry.setState !== 'function' || typeof registry.requireState !== 'function' ||
      typeof registry.requireTable !== 'function' || !(ctx.sessionQuery?._observations?.cache instanceof Map)) {
    refuse('unsupported-runtime', 'The workspace or history runtime is unsupported.');
  }
  searchIndexCleanupMode(ctx.sessionQuery);
  const projection = ctx.storageDomain.get('session_projcache');
  if (!projection || typeof projection.table('sessions')?.delete !== 'function') {
    refuse('checkpoint-unavailable', 'The history checkpoint store is not ready.');
  }
}

/** Test seams are direct constructor dependencies, never accepted by the remote route. */
export function createDeletionService(ctx, config = {}, {
  adapterFactory = buildAdapter, verifyRuntime = verifyCleanupRuntime, now = Date.now,
} = {}) {
  const permits = new Map();
  let initialized;
  let queue = Promise.resolve();
  let releaseFailure = false;
  const hostLabel = os.hostname();
  const initialize = () => initialized ??= (async () => {
    await verifyRuntime(ctx, config.packageRoot);
    const adapter = await adapterFactory(ctx, { packageRoot: path.join(config.packageRoot, 'dsh-session-persistence-jsonl') });
    await adapter.verify();
    return adapter;
  })();
  const requireId = id => { if (!validId(id)) refuse('invalid-session', 'Select a valid archived conversation.'); };
  const queryCache = () => ctx.sessionQuery._observations.cache;
  const projectionTable = () => ctx.storageDomain.get('session_projcache').table('sessions');

  async function assertEligibility(id, { requireStored = true, requireArchived = true } = {}) {
    requireId(id);
    searchIndexCleanupMode(ctx.sessionQuery);
    if (releaseFailure) refuse('restart-required', 'A storage lease did not close cleanly. Restart Harness before deleting another chat.');
    if (requireArchived && !ctx.workspaceRegistry.archivedSessionIds.includes(id)) refuse('not-archived', 'Archive this chat before deleting it.');
    if (ctx.workspaceRegistry.requireState().pinnedSessionIds.includes(id)) {
      refuse('inconsistent-archive', 'Harness reports this chat as both pinned and archived. Resolve that state before deleting it.');
    }
    if (ctx.sessions.get(id) || ctx.agents.get(id)) {
      refuse('loaded', 'This chat is still loaded by Harness. Close other running work and restart Harness, then delete it from Archived without reopening it.');
    }
    const entry = queryCache().get(id);
    if (entry && entry.refs !== 0) refuse('history-in-use', 'Another view is reading this chat. Close that view and try again.');
    const activities = await ctx.waterfall('workspace/session-activity', { sessionId: id }, () => Promise.resolve([]));
    if (!Array.isArray(activities) || activities.length) refuse('activity', 'This chat still has running work, a job, or a schedule. Stop it before deleting.');
    const schedule = ctx.get?.('schedule');
    if (schedule) {
      if (typeof schedule.catalog !== 'function') refuse('unsupported-runtime', 'The schedule service cannot verify this chat.');
      if ((await schedule.catalog()).some(row => row.sessionId === id)) {
        refuse('scheduled', 'This chat has saved reminders. Delete those reminders first, including inactive ones.');
      }
    }
    const snapshots = await ctx.sessionPersistence.list();
    const headers = [...snapshots.map(row => row.header), ...ctx.sessions.list().map(session => session.header)];
    const header = headers.find(row => row.id === id);
    if (requireStored && !header) refuse('not-found', 'This chat is no longer stored on this host.');
    if (header?.origin === 'subagent') refuse('subagent', 'Subagent history belongs to its parent conversation and cannot be deleted separately.');
    if (headers.some(row => row.parentSession === id)) {
      refuse('linked-chats', 'This chat has forks or subagent conversations that refer to it. Deletion is disabled to preserve their history.');
    }
    return header;
  }

  function captureRecovery(id) {
    const registry = ctx.workspaceRegistry;
    const memberships = [...registry.requireTable().entries()]
      .filter(([, record]) => record.sessionIds.includes(id))
      .map(([workspaceId, record]) => ({ workspaceId, index: record.sessionIds.indexOf(id), following: record.sessionIds.slice(record.sessionIds.indexOf(id) + 1) }));
    return {
      version: 1, sessionId: id, archived: true, memberships,
      searchIndexCleanup: searchIndexCleanupMode(ctx.sessionQuery),
      checkpoint: copy(projectionTable().get(id)) ?? null,
      header: copy(registry.headers.get(id)) ?? null,
      sessionPath: registry.sessionPaths.get(id) ?? null,
      missingSessionPath: registry.missingSessionPaths.has(id),
      invalidSessionPath: registry.invalidSessionPaths.get(id) ?? null,
    };
  }

  async function changeMembership(workspaceId, transform) {
    const registry = ctx.workspaceRegistry;
    const table = registry.requireTable();
    if (!table.get(workspaceId)) return;
    const record = await table.update(workspaceId, current => ({ ...current,
      sessionIds: transform(current.sessionIds), updatedAt: new Date().toISOString() }));
    const entity = registry.entities.get(workspaceId);
    if (entity) entity.record = record;
  }

  async function cleanup(id, recovery) {
    await projectionTable().delete(id);
    for (const item of recovery.memberships) await changeMembership(item.workspaceId, ids => ids.filter(value => value !== id));
    const registry = ctx.workspaceRegistry;
    const state = registry.requireState();
    await registry.setState({ ...state, archivedSessionIds: state.archivedSessionIds.filter(value => value !== id),
      pinnedSessionIds: state.pinnedSessionIds.filter(value => value !== id) });
    registry.headers.delete(id);
    registry.sessionPaths.delete(id);
    registry.missingSessionPaths.delete(id);
    registry.invalidSessionPaths.delete(id);
  }

  async function restoreMetadata(id, recovery) {
    const registry = ctx.workspaceRegistry;
    if (recovery.checkpoint !== null) await projectionTable().put(id, recovery.checkpoint);
    if (recovery.header !== null) registry.headers.set(id, recovery.header);
    if (recovery.sessionPath !== null) registry.sessionPaths.set(id, recovery.sessionPath);
    if (recovery.missingSessionPath) registry.missingSessionPaths.add(id);
    if (recovery.invalidSessionPath !== null) registry.invalidSessionPaths.set(id, recovery.invalidSessionPath);
    for (const item of recovery.memberships) await changeMembership(item.workspaceId, ids => {
      if (ids.includes(id)) return ids;
      const next = item.following.find(value => ids.includes(value));
      const at = next === undefined ? Math.min(item.index, ids.length) : ids.indexOf(next);
      return [...ids.slice(0, at), id, ...ids.slice(at)];
    });
    const state = registry.requireState();
    if (!state.archivedSessionIds.includes(id)) await registry.setState({ ...state, archivedSessionIds: [...state.archivedSessionIds, id] });
  }

  async function reconcile(id) {
    const mode = searchIndexCleanupMode(ctx.sessionQuery);
    // In the pinned implementation openAt:'never' refuses search before opening
    // SQLite. Later enabled search always awaits _reconcile before any query;
    // persisted rows absent from sessionPersistence.list are deleted there.
    if (mode === 'reconciled') await ctx.sessionQuery.searchSessions({ query: 'archived-chat-delete-check',
      sessionFilters: [{ kind: 'id', values: [id] }], limit: 1 });
    return mode;
  }

  async function preview({ sessionId }) {
    requireId(sessionId);
    try {
      const adapter = await initialize();
      await assertEligibility(sessionId);
      const snapshot = await adapter.inspect(sessionId);
      for (const [key, permit] of permits) if (permit.expiresAt <= now()) permits.delete(key);
      if (permits.size >= 200) permits.delete(permits.keys().next().value);
      const token = randomUUID();
      const expiresAt = now() + 120_000;
      permits.set(token, { sessionId, snapshot, expiresAt });
      const searchIndexCleanup = searchIndexCleanupMode(ctx.sessionQuery);
      return { eligible: true, sessionId, hostLabel, token, expiresAt,
        searchIndexCleanup,
        message: 'The chat will be removed from Harness. A local recovery backup will remain on this host. Project files and shared attachments are kept.' +
          (searchIndexCleanup === 'deferred-until-enabled' ? ' Search history will be updated if search is enabled later.' : '') };
    } catch (error) {
      return { eligible: false, sessionId, hostLabel, code: safeFailure(error) ? error.code : 'unavailable',
        message: safeFailure(error) ? error.message : 'The host could not verify safe deletion. Nothing was deleted.' };
    }
  }

  async function remove(payload, signal) {
    const { sessionId, token, confirmation } = payload;
    requireId(sessionId);
    const permit = permits.get(token);
    permits.delete(token);
    if (confirmation !== 'delete-archived-chat' || !permit || permit.sessionId !== sessionId || permit.expiresAt <= now()) {
      refuse('confirmation-expired', 'Review this chat again before confirming deletion.');
    }
    const adapter = await initialize();
    // This lock also orders archive/unarchive mutations. Never call their queued public
    // methods from inside it; target state changes below use the audited primitives.
    return ctx.workspaceRegistry.enqueueOperation(async () => {
      signal?.throwIfAborted();
      await assertEligibility(sessionId);
      let lease, receipt, recovery;
      try {
        lease = await adapter.acquire(permit.snapshot);
        await assertEligibility(sessionId);
        recovery = captureRecovery(sessionId);
        signal?.throwIfAborted();
        // Cancellation after this boundary cannot abandon a partially committed transaction.
        receipt = await adapter.quarantine(lease, { manifest: recovery });
        await assertEligibility(sessionId, { requireStored: false });
        await cleanup(sessionId, recovery);
        const searchIndexCleanup = await reconcile(sessionId);
        await assertEligibility(sessionId, { requireStored: false, requireArchived: false });
        if (await ctx.sessionPersistence.stat(sessionId) ||
            (await ctx.sessionQuery.listSessions()).some(row => row.header?.id === sessionId || row.id === sessionId) ||
            projectionTable().get(sessionId) !== undefined || ctx.sessions.get(sessionId)) {
          refuse('verification-failed', 'Harness still reports this chat after removal. Restoring its backup.');
        }
        if ((queryCache().get(sessionId)?.refs ?? 0) !== 0) refuse('history-in-use', 'Another view started reading this chat. Restoring its backup.');
        queryCache().delete(sessionId);
        // Close an empty writer while rollback is still inside the transaction.
        // A release failure must not be reported as a successful deletion.
        await adapter.release(lease);
        await adapter.updateManifest(receipt, { phase: 'complete', searchIndexCleanup, completedAt: new Date().toISOString() });
        return { deleted: true, sessionId, hostLabel, transactionId: receipt.transactionId,
          searchIndexCleanup, backupPath: receipt.backupDir, message: 'Chat deleted from Harness. Its recovery backup was retained.' };
      } catch (error) {
        receipt ||= error.receipt || lease?.receipt;
        if (receipt) {
          try {
            await adapter.rollback(receipt);
            await restoreMetadata(sessionId, recovery);
            const searchIndexCleanup = await reconcile(sessionId);
            await adapter.updateManifest(receipt, { phase: 'rolled-back', searchIndexCleanup, restoredAt: new Date().toISOString() });
          } catch {
            await adapter.updateManifest(receipt, { phase: 'recovery-required' }).catch(() => {});
            refuse('recovery-required', `Removal could not finish or fully roll back. Keep the recovery backup and manifest at ${receipt.manifestPath}; do not retry until it is reviewed.`);
          }
          refuse('rolled-back', 'Deletion could not finish. The archived chat was restored and its backup manifest was retained.');
        }
        throw error;
      } finally {
        if (lease && !lease.released) {
          try { await adapter.release(lease); }
          catch {
            releaseFailure = true;
            if (receipt) await adapter.updateManifest(receipt, { phase: 'release-warning' }).catch(() => {});
            ctx.logger?.warn?.('archived-chat-delete: writer release reported an error; restart Harness before another deletion.');
          }
        }
      }
    });
  }

  return async (operation, payload, signal) => {
    if (operation === 'preview') return preview(payload);
    if (operation !== 'delete') refuse('invalid-operation', 'Unknown archived-chat operation.');
    const result = queue.then(() => remove(payload, signal));
    queue = result.catch(() => {});
    return result;
  };
}
