# dsh-model-switcher

A clickable model-host pill for DeepSeek Harness. Shows the bound host, active
model, loading stages, and elapsed time; offers direct model selection and
conversation-mismatch choices. Package, backend, and client module identity:
`dsh-model-switcher`.

## Install

Use the root `Install.command` for both plugins, or:

```bash
bash "/path/to/dsh-plugins/Install.command" --apply --plugins model-switch
```

Provide your existing gateway v2 address and key at the prompts. Installation
checks its identity and catalog before writing private host bindings. It does
not download weights or install an inference server.

## Required host

This plugin expects the custom `local-model-switch` gateway version 2. Generic
Ollama, MLX, Strata, and OpenAI-compatible endpoints do not expose its control
API. The current catalog includes the four Qwen IDs in `catalog.mjs`; changing
the model catalog requires corresponding server/client validation changes.
See [gateway protocol](../../docs/gateway-protocol.md).

All clients of a gateway share its loaded model. Opening the pill or a saved
conversation only observes status. Selecting a model explicitly requests a load;
the composer stays blocked until that exact model is ready. Unrelated providers
are left alone. Loading progress is real stages and elapsed time, not a percentage.

If another chat uses different weights, choose **Use loaded model** or
**Load conversation model**. An existing response can finish before unloading;
later inactive-model requests fail rather than automatically switching back.
This plugin does not automatically replay failed tasks.

## Compatibility and privacy

Each configured host has its own URL, provider ID, credential reference, and
pinned gateway UUID. The key remains in Harness's credential store and host
bridge; it is not returned to the client UI. The installer preserves existing
bindings and rejects redirected or mismatched host configurations.

Older `windows-model-switch-client` / `local-model-switch-client` registrations
are recognized during upgrade. The installer moves registrations to
`~/.dsh/plugins/dsh-model-switcher` while leaving old runtime files for rollback.
The established RPC namespace and `local-model-switch-client.json` configuration
filename remain compatible.

Native Mac installation has not yet been completed. See the root
[validation record](../../docs/validation.md) and installation instructions.
