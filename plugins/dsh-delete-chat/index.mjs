/** Owner-authenticated Harness routes; no inference gateway or unauthenticated API. */
import { createDeletionService, safeFailure } from './service.mjs';

export const name = 'dsh-delete-chat';
export const inject = [];

export function createRpcHandler(service) {
  return async (operation, payload, signal, peer) => {
    if (peer?.principal?.kind !== 'owner') return { ok: false, error: {
      code: 'archived-chat-delete/denied', message: 'Only this Harness host owner can delete archived chats.', details: {} } };
    try { return { ok: true, value: await service(operation, payload, signal) }; }
    catch (error) { return { ok: false, error: { code: safeFailure(error)
      ? (error.code.startsWith('archived-chat-delete/') ? error.code : `archived-chat-delete/${error.code}`) : 'archived-chat-delete/unavailable',
      message: safeFailure(error) ? error.message : 'Deletion could not finish. Refresh the archived list and review the chat again.', details: {} } }; }
  };
}

export function createFetchRoute(operation, service) {
  if (!['preview', 'delete'].includes(operation)) throw new Error('Unknown archived-chat operation.');
  const endpoint = `archived-chat-delete/${operation}`;
  const response = (value, status = 200) => new Response(JSON.stringify(value), {
    status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
  return { path: `/api/${endpoint}`, methods: ['POST'], requestBody: 'buffered', async fetch(request) {
    if (request.headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase() !== 'application/json') return response({ error: 'Expected JSON.' }, 415);
    let envelope;
    try { const raw = await request.text(); if (raw.length > 8192) return response({ error: 'Request too large.' }, 413); envelope = JSON.parse(raw); }
    catch { return response({ error: 'Invalid JSON.' }, 400); }
    if (envelope?.type !== 'client-request' || envelope.method !== endpoint || typeof envelope.rpcId !== 'string' ||
        !envelope.rpcId || envelope.rpcId.length > 256 || !envelope.payload || typeof envelope.payload !== 'object' || Array.isArray(envelope.payload)) {
      return response({ error: 'Invalid RPC envelope.' }, 400);
    }
    // HostConnection admits only owner peers before dispatching an exact Fetch route.
    const result = await createRpcHandler(service)(operation, envelope.payload, request.signal, { principal: { kind: 'owner' } });
    return response({ type: 'server-response', rpcId: envelope.rpcId, result });
  } };
}

export function apply(ctx, config = {}) {
  if (config.setupRequired === true) {
    throw new Error('Delete Chat needs one-time setup. Quit Harness and follow the setup instructions in this plugin\'s README to verify the installed Harness build and run the native safety checks.');
  }
  ctx.inject(['connection', 'workspaceRegistry', 'sessionPersistence', 'sessionQuery', 'sessionProjectionCache', 'storageDomain', 'sessions', 'agents'], scope => {
    const service = createDeletionService(scope, config);
    for (const operation of ['preview', 'delete']) scope.connection.fetch.register(createFetchRoute(operation, service));
  });
}
