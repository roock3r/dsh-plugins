# dsh-delete-chat

Delete eligible archived chats from DeepSeek Harness, with confirmation and a
local recovery backup. A community plugin, not an official DeepSeek product.

## Install from GitHub

In Harness **Plugins → Add plugin**, enter:

```text
https://github.com/roock3r/dsh-delete-chat
```

Choose **Enable now** when Harness offers to register the downloaded bundle.
Its individual plugin row starts **Off** and remains inactive. Leave that row
off until the Mac setup below completes the required runtime checks. Registering
the bundle does not authorize deletion.
The equivalent shorthand is `github:roock3r/dsh-delete-chat`.

## Complete setup on Mac

1. Download `dsh-delete-chat-mac.zip` from this repository's
   [releases](https://github.com/roock3r/dsh-delete-chat/releases), using the same
   release/build as the installed GitHub package, and extract the complete folder.
2. Quit DeepSeek Harness completely with **Command-Q**.
3. Double-click `Install.command`, or run:

   ```bash
   bash "/path/to/dsh-delete-chat/Install.command"
   ```

4. The bundled installer identifies the actual Harness packages and tests
   deletion and rollback using temporary synthetic chats before activation.
   It configures the profiles where you registered this GitHub bundle.
5. Reopen Harness. Choose **View options → Archived only**, then a chat's trash
   button or **Delete archived chat…**. Confirm the host and selected chat.

This standalone setup includes everything it needs locally. It does not fetch
the combined plugin suite, install another plugin, or contact a model server.
The archive plugin needs no inference URL or API key. If the GitHub bundle has
not been added, the same installer can install this plugin directly.

## Storage and compatibility

Deletion affects the connected Harness host's chat storage. A Mac running
Harness with Windows-hosted model inference still deletes its Mac-local chats.
The model gateway never receives deletion requests.

The plugin accepts audited source builds `0.2.1-rc.5` and `0.2.2-rc.1`; unknown or
modified builds are refused. Loaded or busy chats, linked descendants, reminders,
and subagents block deletion. Project files and shared attachments remain.
Recovery backups remain on disk; this is not secure erasure or an in-app Undo.

Windows synthetic native fixtures passed. **Live installation on the target Mac
has not yet been completed.** Mac native preflight must pass during setup.
The bundled setup launcher is for macOS. Windows activation is not automated by
this installer. See [plugin details and recovery](docs/plugin-details.md) and the
[canonical validation record](docs/validation.md).

## Rollback and development

Quit Harness and run `Uninstall.command` to undo this plugin's latest installer
transaction. Rollback preserves newer edits and refuses another plugin's receipt.
This does not restore deleted chats; their recovery manifests describe backups.
Before using Harness's **Remove plugin**, run this rollback first so its enabled
profile override is removed. If newer edits prevent rollback, reconcile those
edits before removing the bundle. When updating the GitHub package, use the
installer and runtime from the same release/build for configuration; mismatches
are refused. A distribution's prerelease tag can differ from the preserved
plugin package version.

Run `npm test` with Node 24 for portable checks; installed-runtime fixtures are
optional and do not replace native Mac proof. This is a generated standalone
repository. Make source changes in the [canonical workspace](SOURCE.md).

MIT, copyright 2026 Cristian Silva. See [LICENSE](LICENSE) and
[third-party notices](THIRD-PARTY-NOTICES.md).
