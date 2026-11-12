export function hostProvider(id) { return `windows-${id}`; }
export function hostCredentialRef(id) { return `DSH_SWITCH_${id.toUpperCase().replaceAll('-', '_')}_KEY`; }
// Legacy seed used only for migration and installer fixtures. Live choices come
// from the pinned gateway; this list is never a runtime authorization list.
export const MODELS = Object.freeze([
  { id: 'qwen3.8-flash-next-unsloth-ud-q4_k_xl', name: 'Qwen Flash Q4', contextWindow: 32768, maxTokens: 8192, input: ['text'], reasoningEfforts: { off: 'none', medium: 'medium' } },
  { id: 'qwen3.8-flash-next-sc117-iq3_s', name: 'SC117 Flash IQ3_S', contextWindow: 32768, maxTokens: 8192, input: ['text'], reasoningEfforts: { off: 'none', medium: 'medium' } },
  { id: 'qwen3.8-27b-rtx4080', name: 'Qwen 27B Q4', contextWindow: 32768, maxTokens: 4096, input: ['text'], reasoningEfforts: { off: 'none', low: 'low', medium: 'medium', high: 'xhigh' } },
  { id: 'qwen3.8-27b-uncensored-rtx4080', name: 'Qwen 27B Uncensored Q4', contextWindow: 32768, maxTokens: 4096, input: ['text'], reasoningEfforts: { off: 'none', medium: 'medium' } },
]);
export const MODEL_IDS = MODELS.map(model => model.id);

const fail = () => { throw new Error('The model host returned an invalid model catalog.'); };
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
export const validModelId = id => typeof id === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._:/+-]{0,199}$/.test(id) &&
  !['__proto__', 'prototype', 'constructor'].includes(id);
const cleanText = value => typeof value === 'string' && value.trim() && value.length <= 200 && !/[\u0000-\u001f\u007f]/.test(value);
const levels = new Set(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']);
const wireLevels = new Set(['none', 'off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']);

/** Copy only model capability fields. Endpoint/auth configuration is host-owned. */
export function validateModels(rows) {
  if (!Array.isArray(rows) || rows.length > 256) fail();
  const seen = new Set();
  return rows.map(row => {
    if (!object(row) || !validModelId(row.id) || seen.has(row.id)) fail();
    seen.add(row.id);
    if (['baseURL', 'baseUrl', 'api', 'apiKey', 'apiKeyEnv', 'headers', 'modelOverrides', 'compat'].some(key => Object.hasOwn(row, key))) fail();
    const name = row.name ?? row.label;
    if (!cleanText(name) || !Number.isSafeInteger(row.contextWindow) || row.contextWindow < 256 || row.contextWindow > 2097152 ||
        !Number.isSafeInteger(row.maxTokens) || row.maxTokens < 1 || row.maxTokens > Math.min(row.contextWindow, 262144)) fail();
    if (!Array.isArray(row.input) || !row.input.includes('text') || row.input.length > 2 ||
        new Set(row.input).size !== row.input.length || row.input.some(value => !['text', 'image'].includes(value))) fail();
    let reasoningEfforts = false;
    if (row.reasoningEfforts !== undefined && row.reasoningEfforts !== false) {
      if (!object(row.reasoningEfforts)) fail();
      const entries = Object.entries(row.reasoningEfforts);
      if (!entries.length || !entries.some(([key]) => key !== 'off') || entries.some(([key, value]) =>
        !levels.has(key) || !(wireLevels.has(value) || (key === 'off' && value === null)))) fail();
      reasoningEfforts = Object.fromEntries(entries);
    }
    return { id: row.id, name: name.trim(), contextWindow: row.contextWindow, maxTokens: row.maxTokens,
      input: [...row.input], reasoningEfforts };
  });
}

export function validateCatalog(value, expectedGatewayId) {
  if (!object(value) || value.gateway !== 'local-model-switch' || value.version !== 2 ||
      typeof value.gatewayId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value.gatewayId)) fail();
  if (expectedGatewayId && value.gatewayId !== expectedGatewayId) throw new Error('The server identity does not match this saved host.');
  return { gateway: value.gateway, version: 2, gatewayId: value.gatewayId, models: validateModels(value.models) };
}
