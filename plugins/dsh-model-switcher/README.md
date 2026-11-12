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
API. Model names, context/reply limits, and reasoning capabilities come from the
gateway's available-model catalog. The client polls that catalog while connected
and updates the managed provider when it changes. Additional supported server
recipes do not require rebuilding the Mac plugin. Host labels remain separate
from model names.
See [gateway protocol](../../docs/gateway-protocol.md).

All clients of a gateway share its loaded model. Opening the pill or a saved
conversation only observes status. Selecting a model explicitly requests a load;
the composer stays blocked until that exact model is ready. Unrelated providers
are left alone. Loading progress is real stages and elapsed time, not a percentage.

If another chat uses different weights, choose **Use loaded model** or
**Load conversation model**. An existing response can finish before unloading;
later inactive-model requests fail rather than automatically switching back.
This plugin does not automatically replay failed tasks.

The server must filter out disabled, missing, or unavailable recipes. Finding a
model in Ollama or a weights folder does not prove it can be served through this
gateway. Such candidates stay unselectable until the host has a supported load
and chat configuration. Availability checks do not run inference or download
anything. A load can still fail later; the composer stays blocked in that case.

If discovery fails or returns no available models, the pill offers none and
blocks sending to that host. Harness cannot represent an empty custom-provider
catalog, so its native picker may retain the last saved entries until a nonempty
catalog returns. Those stale entries do not bypass the switcher's readiness
checks. Existing conversation selections are preserved, never silently replaced.

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
