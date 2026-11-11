export function hostProvider(id) { return `windows-${id}`; }
export function hostCredentialRef(id) { return `DSH_SWITCH_${id.toUpperCase().replaceAll('-', '_')}_KEY`; }
export const MODELS = Object.freeze([
  { id: 'qwen3.8-flash-next-unsloth-ud-q4_k_xl', name: 'Windows Qwen Flash Q4', contextWindow: 32768, maxTokens: 8192, input: ['text'], reasoningEfforts: { off: 'none', medium: 'medium' } },
  { id: 'qwen3.8-flash-next-sc117-iq3_s', name: 'Windows SC117 Flash IQ3_S', contextWindow: 32768, maxTokens: 8192, input: ['text'], reasoningEfforts: { off: 'none', medium: 'medium' } },
  { id: 'qwen3.8-27b-rtx4080', name: 'Windows Qwen 27B Q4', contextWindow: 32768, maxTokens: 4096, input: ['text'], reasoningEfforts: { off: 'none', low: 'low', medium: 'medium', high: 'xhigh' } },
  { id: 'qwen3.8-27b-uncensored-rtx4080', name: 'Windows Qwen 27B Uncensored Q4', contextWindow: 32768, maxTokens: 4096, input: ['text'], reasoningEfforts: { off: 'none', medium: 'medium' } },
]);
export const MODEL_IDS = MODELS.map(model => model.id);
