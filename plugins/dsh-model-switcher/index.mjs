/** Host bridge for the local model switcher. Credentials never cross to the client. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const name = 'dsh-model-switcher';
export const inject = [];
export { MODEL_IDS as MODELS } from './catalog.mjs';
import { validateCatalog, validateModels, validModelId } from './catalog.mjs';
import { loadGatewayConfig, readClientConfig, validateGatewayURL } from './settings.mjs';
const ensureDefault = hostId => loadGatewayConfig({ hostId });

export function publicHost(host) {
  return { id: host.id, label: host.label, url: host.url, provider: host.provider, gatewayId: host.gatewayId };
}

/** Inspect live public provider settings without reading or returning secret values. */
function providerBinding(ctx, host, model) {
  const entries = ctx.llm.listConfigurableProviders().filter(row => row.provider === host.provider);
  if (entries.length !== 1 || ctx.llm.listProviders().filter(row => row.id === host.provider || row.provider === host.provider).length !== 1) return false;
  const entry = entries[0];
  if (typeof entry.settingsNs !== 'string' || !Array.isArray(entry.settingsPath) || !entry.settingsPath.length) return false;
  const descriptors = ctx.settings.describe({ redactSecrets: true }).filter(row => row.ns === entry.settingsNs);
  if (descriptors.length !== 1) return false;
  let provider = descriptors[0].value;
  for (const segment of entry.settingsPath) {
    if ((typeof segment !== 'string' && !Number.isSafeInteger(segment)) || ['__proto__', 'prototype', 'constructor'].includes(segment) ||
        !provider || typeof provider !== 'object' || !Object.hasOwn(provider, segment)) return false;
    provider = provider[segment];
  }
  if (!provider || provider.api !== 'openai-completions' || provider.apiKeyEnv !== host.credentialRef) return false;
  let url;
  try { url = new URL(provider.baseURL); } catch { return false; }
  if (url.href.replace(/\/$/, '') !== `${host.url}/v1`) return false;
  if (!provider.headers || typeof provider.headers !== 'object' || Array.isArray(provider.headers)) return false;
  if (Object.keys(provider.headers).some(key => ['authorization', 'x-api-key', 'api-key', 'x-auth-token'].includes(key.toLowerCase()))) return false;
  const pin = Object.entries(provider.headers).filter(([key]) => key.toLowerCase() === 'x-local-model-gateway-id');
  if (pin.length !== 1 || pin[0][1] !== host.gatewayId) return false;
  const configured = Array.isArray(provider.models) ? provider.models : [];
  if (model && configured.filter(row => row.id === model).length !== 1) return false;
  for (const row of configured) {
    if (['baseURL', 'api', 'apiKeyEnv', 'headers'].some(key => row[key] !== undefined || provider.modelOverrides?.[row.id]?.[key] !== undefined)) return false;
  }
  return { entry, descriptor: descriptors[0], provider };
}

export function bindingApplies(ctx, host, model) { return Boolean(providerBinding(ctx, host, model)); }

function comparableModels(rows) {
  return rows?.map(row => {
    const result = { ...row };
    // SettingsForms resolves these schema defaults even when the profile never
    // stored compat. Do not rewrite the same catalog on every polling interval.
    if (result.compat && typeof result.compat === 'object' && !Array.isArray(result.compat) &&
        Object.entries(result.compat).every(([key, value]) => ['chatTemplateKwargs', 'chatTemplateArgs'].includes(key) &&
          value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === 0)) delete result.compat;
    return result;
  });
}

/** Apply one revision-checked field edit; never restate redacted credentials. */
export async function synchronizeProviderModels(ctx, host, rows) {
  const models = validateModels(rows);
  // This Harness build refuses an empty custom provider. Keep its last document
  // so existing chats retain their references; the live pill/gateway stay closed.
  if (!models.length) return false;
  for (let attempt = 0; attempt < 2; attempt++) {
    const binding = providerBinding(ctx, host);
    if (!binding) throw new Error('The model host provider binding changed.');
    if (JSON.stringify(comparableModels(binding.provider.models)) === JSON.stringify(models)) return false;
    if (!Number.isSafeInteger(binding.descriptor.revision) || typeof ctx.settings.mutate !== 'function') {
      throw new Error('This Harness build cannot safely refresh the model list.');
    }
    try {
      await ctx.settings.mutate(binding.entry.settingsNs,
        [{ op: 'set', path: [...binding.entry.settingsPath, 'models'], value: models }], binding.descriptor.revision);
      if (!bindingApplies(ctx, host)) throw new Error('The model host provider binding changed.');
      return true;
    } catch (error) {
      if (attempt || error?.code !== 'SETTINGS_CONFLICT') throw error;
    }
  }
}

/** Only bounded, non-secret model state may be returned through Harness RPC. */
export function publicStatus(value) {
  if (value?.gateway !== 'local-model-switch' || value.version !== 2) {
    throw new Error('The local model switcher did not return a recognized status.');
  }
  const modelOrNull = value => validModelId(value) ? value : null;
  return {
    gateway: value.gateway, version: 2,
    gatewayId: value.gatewayId,
    phase: typeof value.phase === 'string' ? value.phase.slice(0, 48) : 'unknown',
    loadedModel: modelOrNull(value.loadedModel),
    loadingModel: modelOrNull(value.loadingModel),
    desiredModel: modelOrNull(value.desiredModel),
    ready: value.ready === true,
    backendReady: value.backendReady === true,
    activeModel: modelOrNull(value.activeModel),
    applies: true,
    error: value.error ? 'The selected model could not be loaded. Retry, or check the local model-switch logs.' : null,
    updatedAt: typeof value.updatedAt === 'string' ? value.updatedAt.slice(0, 40) : null,
    activeRequests: Number.isSafeInteger(value.activeRequests) ? value.activeRequests : 0,
    queuedRequests: Number.isSafeInteger(value.queuedRequests) ? value.queuedRequests : 0,
  };
}

export function createBridge({ ensureGateway = ensureDefault, getHosts = () => readClientConfig().hosts,
  applies = () => true, synchronize = async () => {}, fetcher = fetch, now = Date.now, catalogTtl = 30000 } = {}) {
  const catalogs = new Map(), refreshing = new Map();
  return async (operation, payload = {}, signal) => {
    if (!['hosts', 'catalog', 'status', 'prepare'].includes(operation)) throw new Error('Unknown model-switch operation.');
    if (operation === 'hosts') return { hosts: getHosts().map(publicHost) };
    if (typeof payload.hostId !== 'string') throw new Error('Choose a configured model host.');
    if (operation === 'prepare' && !validModelId(payload.model)) {
      throw new Error('Choose an available model on this host.');
    }
    signal?.throwIfAborted();
    const host = await ensureGateway(payload.hostId);
    const { baseURL, key } = host;
    if (!applies(host)) return { applies: false, hostId: host.id };
    // The URL and credential come from the saved host binding, never the RPC caller.
    if (validateGatewayURL(baseURL) !== baseURL || typeof key !== 'string' || !key) {
      throw new Error('The local model switcher is not configured.');
    }
    const requestSignal = AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(operation === 'prepare' ? 660_000 : 10_000)]);
    const request = async op => {
      const response = await fetcher(`${baseURL}/local-switch/${op}`, {
        method: op === 'prepare' ? 'POST' : 'GET',
        headers: { Authorization: `Bearer ${key}`, 'x-local-model-gateway-id': host.gatewayId,
          ...(op === 'prepare' ? { 'Content-Type': 'application/json' } : {}) },
        ...(op === 'prepare' ? { body: JSON.stringify({ model: payload.model }) } : {}),
        signal: requestSignal, redirect: 'error',
      });
      if (!response.ok) throw new Error(response.status === 409 ? 'The host identity or model selection changed. Review the configured host.' : 'The selected model host is unavailable.');
      const value = await response.json();
      if (value.gatewayId !== host.gatewayId) throw new Error('The server identity does not match this saved host. No model was requested.');
      return value;
    };
    const fingerprint = `${host.gatewayId}|${host.baseURL}|${host.credentialRef}`;
    let catalog = catalogs.get(host.id);
    if (!catalog || catalog.fingerprint !== fingerprint || now() - catalog.checkedAt >= catalogTtl || operation === 'prepare' || payload.refresh === true) {
      const refreshKey = `${host.id}|${fingerprint}`;
      let pending = refreshing.get(refreshKey);
      if (!pending) {
        pending = (async () => {
          try {
            const value = validateCatalog(await request('models'), host.gatewayId);
            if (!applies(host)) return { applies: false };
            await synchronize(host, value.models);
            if (!applies(host)) return { applies: false };
            return { fingerprint, checkedAt: now(), models: value.models, catalogReady: true,
              catalogRevision: (catalogs.get(host.id)?.catalogRevision || 0) + 1 };
          } catch (error) {
            return { fingerprint, checkedAt: now(), models: [], catalogReady: false, failure: error,
              catalogRevision: (catalogs.get(host.id)?.catalogRevision || 0) + 1 };
          }
        })();
        refreshing.set(refreshKey, pending);
        void pending.finally(() => { if (refreshing.get(refreshKey) === pending) refreshing.delete(refreshKey); });
      }
      catalog = await pending;
      if (catalog.applies === false || !applies(host)) return { applies: false, hostId: host.id };
      catalogs.set(host.id, catalog);
      if (catalog.failure && (operation === 'prepare' || signal?.aborted)) throw catalog.failure;
    }
    const availability = { models: catalog.models, catalogReady: catalog.catalogReady, catalogRevision: catalog.catalogRevision,
      modelAvailable: catalog.models.some(row => row.id === payload.model),
      catalogError: catalog.catalogReady ? null : 'Model availability could not be verified. Check the server connection and refresh.' };
    if (operation === 'catalog') return { ...availability, gatewayId: host.gatewayId, hostId: host.id };
    if (operation === 'prepare' && !availability.modelAvailable) throw new Error('That model is not currently available on this host.');
    // Pin the server before a mutating request, even if an endpoint ignores our header.
    let result = publicStatus(await request('status'));
    if (!applies(host)) return { applies: false, hostId: host.id };
    if (operation === 'prepare') {
      if (!applies(host, payload.model)) return { applies: false, hostId: host.id };
      result = publicStatus(await request('prepare'));
    }
    if (!applies(host)) return { applies: false, hostId: host.id };
    return { ...result, ...availability, hostId: host.id };
  };
}

export function createRpcHandler(bridge) {
  return async (endpoint, payload, signal, peer) => {
    if (peer?.principal?.kind !== 'owner') {
      return { ok: false, error: { code: 'local-model-switch/denied', message: 'Only the local Harness owner can control model loading.', details: {} } };
    }
    const operation = endpoint.slice('windows-model-switch-client/'.length);
    try {
      return { ok: true, value: await bridge(operation, payload, signal) };
    } catch (error) {
      return { ok: false, error: { code: 'local-model-switch/unavailable', message: error?.name === 'AbortError' ? 'Model preparation was canceled.' : 'The model switcher is unavailable or the selected model did not finish loading. Check its status and retry.', details: {} } };
    }
  };
}

/** Exact routes are additive; the stock Typert gateway owns the sole RPC interceptor. */
export function createFetchRoute(operation, bridge) {
  if (!['hosts', 'catalog', 'status', 'prepare'].includes(operation)) throw new Error('Unknown model-switch operation.');
  const endpoint = `windows-model-switch-client/${operation}`;
  const response = (value, status = 200) => new Response(JSON.stringify(value), {
    status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
  return {
    path: `/api/${endpoint}`, methods: ['POST'], requestBody: 'buffered',
    // HostConnection's exact Fetch route dispatcher admits owner peers only,
    // including native IPC. This callback is never a raw unauthenticated HTTP route.
    async fetch(request) {
      if (request.headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase() !== 'application/json') {
        return response({ error: 'Expected a JSON RPC request.' }, 415);
      }
      let envelope;
      try {
        const raw = await request.text();
        if (raw.length > 8192) return response({ error: 'Model-switch RPC request is too large.' }, 413);
        envelope = JSON.parse(raw);
      } catch { return response({ error: 'Invalid JSON RPC request.' }, 400); }
      if (!envelope || envelope.type !== 'client-request' || envelope.method !== endpoint ||
          typeof envelope.rpcId !== 'string' || !envelope.rpcId || envelope.rpcId.length > 256 ||
          !envelope.payload || typeof envelope.payload !== 'object' || Array.isArray(envelope.payload)) {
        return response({ error: 'Invalid model-switch RPC envelope.' }, 400);
      }
      // Reuse bounded success/error marshalling; owner admission already happened
      // in the stock exact-route dispatcher before this callback was invoked.
      const result = await createRpcHandler(bridge)(endpoint, envelope.payload, request.signal, { principal: { kind: 'owner' } });
      return response({ type: 'server-response', rpcId: envelope.rpcId, result });
    },
  };
}

export function apply(ctx, config = {}) {
  if (config.setupRequired === true) {
    throw new Error('Model Switcher needs one-time setup. Quit Harness and follow the setup instructions in this plugin\'s README to verify the model host and save its credential.');
  }
  // The gateway owns the only generation barrier. A per-agent prepare hook would
  // let an old background request override a newer explicit dropdown selection.
  ctx.inject(['connection', 'credentials', 'llm', 'settings'], scope => {
    const bridge = createBridge({ ensureGateway: hostId => loadGatewayConfig({ hostId, resolveCredential: ref => scope.credentials.resolve(ref) }),
      applies: (host, model) => bindingApplies(scope, host, model),
      synchronize: (host, models) => synchronizeProviderModels(scope, host, models) });
    for (const operation of ['hosts', 'catalog', 'status', 'prepare']) {
      scope.connection.fetch.register(createFetchRoute(operation, bridge));
    }
    scope.effect(() => {
      const stop = new AbortController();
      let pending = false;
      const refresh = async () => {
        if (pending || stop.signal.aborted) return;
        pending = true;
        try {
          const { hosts } = await bridge('hosts');
          await Promise.allSettled(hosts.map(host => bridge('catalog', { hostId: host.id }, stop.signal)));
        } catch { /* Catalog status remains unavailable; never switch or replay work. */ }
        finally { pending = false; }
      };
      void refresh();
      const interval = setInterval(refresh, 30000);
      interval.unref?.();
      return () => { stop.abort(); clearInterval(interval); };
    }, 'local-model-switch: catalog polling');
  });
  ctx.effect(() => {
    const statusFile = path.join(process.env.DSH_HOME || path.join(os.homedir(), '.dsh'), 'local-model-switch-client-status.json');
    const state = { active: true, version: 2, remoteClient: true, pid: process.pid, loadedAt: new Date().toISOString() };
    fs.mkdirSync(path.dirname(statusFile), { recursive: true });
    fs.writeFileSync(statusFile, JSON.stringify(state, null, 2));
    // This client never starts or stops a server process on the Mac.
    return () => {
      try {
        if (JSON.parse(fs.readFileSync(statusFile, 'utf8')).pid === process.pid) {
          fs.writeFileSync(statusFile, JSON.stringify({ ...state, active: false }, null, 2));
        }
      } catch { /* No shared gateway shutdown on plugin teardown. */ }
    };
  }, 'local-model-switch: presence');
}
