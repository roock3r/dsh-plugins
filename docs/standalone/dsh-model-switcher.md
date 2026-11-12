# dsh-model-switcher

A clickable model-host pill for DeepSeek Harness. Inspect the connected host,
switch its active model, and watch real loading stages beside the chat composer.
A community plugin, not an official DeepSeek product.

## Install from GitHub

In Harness **Plugins → Add plugin**, enter:

```text
https://github.com/roock3r/dsh-model-switcher
```

Choose **Enable now** when Harness offers to register the downloaded bundle.
Its individual plugin row starts **Off** and remains inactive. Leave that row
off until the Mac setup below configures its host, credential, and model provider.
Downloading and registering the bundle alone does not configure the connection.
The equivalent shorthand is `github:roock3r/dsh-model-switcher`.

## Complete setup on Mac

1. Download `dsh-model-switcher-mac.zip` from this repository's
   [releases](https://github.com/roock3r/dsh-model-switcher/releases), using the same
   release/build as the installed GitHub package, and extract the complete folder.
2. Quit DeepSeek Harness completely with **Command-Q**.
3. Double-click `Install.command`, or run:

   ```bash
   bash "/path/to/dsh-model-switcher/Install.command"
   ```

4. Enter your gateway address, the API key, and a friendly host label at the
   labeled prompts. Press **Enter** after each answer. Use the gateway origin
   (for example `http://192.168.50.10:8083`), without `/v1`. API-key characters
   intentionally do not appear while typing or pasting. For a label such as
   `Office AI Server`, type a new name or press Enter to keep the shown default.
   Setup verifies its identity and model catalog before writing the connection.
   It configures the profiles where you registered this GitHub bundle.
5. Reopen Harness. Select a model under the named provider, then click the pill
   above the composer to inspect its host or choose another model.

This package bundles its complete installer; setup does not fetch the combined
suite or the delete-chat plugin. If the GitHub bundle has not been added, the
same installer can install this plugin directly. No weights or inference runtime
are included or downloaded.

## Required model host

An existing compatible **model-switch gateway v2** is required. A bare Ollama,
MLX, Strata, or generic OpenAI-compatible endpoint does not implement its control
protocol. The plugin reads model names and capabilities from the gateway and
refreshes the list while connected. New supported models need a server load/chat
recipe and available backend files; they no longer need a Mac plugin rebuild.
Discovered files or Ollama tags without a supported recipe are not selectable.
See the
[gateway protocol](docs/gateway-protocol.md).

All clients of a gateway share its loaded weights. Existing responses finish
before switching. Opening a conversation or inspecting another host checks
status only. If a conversation expects other weights, choose **Use loaded model**
or **Load conversation model**. Sending waits for the exact selected model.
Failed tasks are not replayed automatically.

Hosts have separate provider IDs, URLs, pinned gateway identities, and credential
references. API keys stay in Harness's private credential store, outside the
renderer and this distribution. Other providers remain independent.

## Compatibility, rollback, and development

**Live installation on the target Mac has not yet been completed.** Windows
runtime and portable checks are recorded in the
[canonical validation record](docs/validation.md). The bundled launcher is for
macOS; it does not install a server on Windows.
Windows activation is not automated by this installer.

Quit Harness and run `Uninstall.command` to undo this plugin's latest installer
transaction. Newer edits and other plugins' receipts are protected. See
[plugin details](docs/plugin-details.md) for migration and host behavior.
Before using Harness's **Remove plugin**, run this rollback first so its enabled
profile override is removed. If newer edits prevent rollback, reconcile those
edits before removing the bundle. When updating the GitHub package, configure it
using the installer and runtime from the same release/build; mismatches are
refused. A distribution's prerelease tag can differ from the preserved plugin
package version.

Run `npm test` with Node 24. This is a generated standalone repository; make source
changes in the [canonical workspace](SOURCE.md).

MIT, copyright 2026 Cristian Silva. See [LICENSE](LICENSE) and
[third-party notices](THIRD-PARTY-NOTICES.md).
