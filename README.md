# DSH plugins

A model-host pill and archived-chat deletion for DeepSeek Harness, with a combined
macOS installer. A community extension, not an official DeepSeek product.
Both packages are experimental and support the audited Harness builds listed below.

Experimental suite release: **`v0.1.0-alpha.1`**.
Source: [`roock3r/dsh-plugins`](https://github.com/roock3r/dsh-plugins).
See [GitHub releases](https://github.com/roock3r/dsh-plugins/releases) for downloads.

This repository remains the canonical source workspace. Individual distributions
are available through [dsh-delete-chat](https://github.com/roock3r/dsh-delete-chat)
and [dsh-model-switcher](https://github.com/roock3r/dsh-model-switcher), each with
its own GitHub plugin bundle and self-contained Mac setup. Register the downloaded
bundle with **Enable now**; its individual plugin stays off until setup succeeds.
See [standalone distribution maintenance](docs/standalone-distributions.md).

| Plugin | Controls | Runs on |
| --- | --- | --- |
| [dsh-model-switcher](plugins/dsh-model-switcher/README.md) | Active model on a configured Windows gateway | Mac Harness client; inference stays on Windows |
| [dsh-delete-chat](plugins/dsh-delete-chat/README.md) | Archived conversations in the connected Harness host's storage | Mac or Windows Harness host |

**Using Windows-hosted models does not move Mac chats to Windows.** A Mac running
its own Harness deletes its Mac-local chats. The Windows model gateway never
receives chat-deletion requests.

## Install on the Mac

1. Extract the full `dsh-plugins-mac.zip` folder. Keep its files together.
2. Open DeepSeek Harness once, then quit completely with **Command-Q**.
3. Double-click **Install.command**, or run it from Terminal:

   ```bash
   bash "/path/to/dsh-plugins/Install.command"
   ```

4. Enter the Windows gateway address, host label, and API key when prompted.
   No address or key is built in. The key prompt hides your input.
5. The installer checks the gateway identity/catalog and installed Harness build,
   then exercises deletion and recovery with temporary synthetic chats. It writes
   the plugins only after the required checks pass.
6. Reopen Harness. Select a model under your named Windows provider, then click
   the pill above the composer to inspect the host or switch models.

The default installs both plugins in the desktop profile. Existing web/headless
profiles can receive the model client; archive registration there requires a
verified CLI runtime. Unverified profiles are reported. Other providers, default
selections, credentials, comments, and executable YAML tags are preserved.

The launcher uses Harness's bundled runtime from `/Applications` or
`~/Applications`. Node is a fallback, but archive installation still requires
readable verified Harness packages. No model weights are included or downloaded.
The vendored YAML parser avoids an npm install during setup.

### Install either plugin separately

```bash
# Mac-local archives only: no Windows connection or API key needed.
bash "/path/to/dsh-plugins/Install.command" --apply --plugins archive-delete

# Remote model picker only.
bash "/path/to/dsh-plugins/Install.command" --apply --plugins model-switch

# Check without writing user profiles or plugin files.
# Archive checks use only their own temporary synthetic storage.
bash "/path/to/dsh-plugins/Install.command" --check --plugins both
```

## Model pill

Click the pill to inspect the host, loaded weights, and model choices. Select a
model to load it. Real waiting/unloading/loading stages and elapsed seconds remain
visible in the collapsed pill. Sending stays blocked until the exact model is
ready; there is no estimated percentage.

Opening a chat or picker only checks status. If a chat uses another model, choose
**Use loaded model** or **Load conversation model**. Inspecting another configured
host does not load weights; selecting one of its models explicitly changes this
chat's provider and requests that host's model.

All clients of one gateway share its active weights. Existing responses finish
before switching. Later requests for inactive weights fail instead of switching
back silently. Failed agent tasks are not automatically replayed.

The current catalog matches these existing gateway IDs:

| Model ID | Context | Reply cap |
| --- | ---: | ---: |
| `qwen3.8-flash-next-unsloth-ud-q4_k_xl` | 32,768 | 8,192 |
| `qwen3.8-flash-next-sc117-iq3_s` | 32,768 | 8,192 |
| `qwen3.8-27b-rtx4080` | 32,768 | 4,096 |
| `qwen3.8-27b-uncensored-rtx4080` | 32,768 | 4,096 |

The **model-switch gateway v2 must already exist**. A bare Ollama, MLX, Strata, or
generic OpenAI-compatible URL does not implement its control protocol. This repo
does not install the gateway or inference runtimes. See [gateway requirements](docs/gateway-protocol.md).

## Delete archived chats

Choose **View options → Archived only** under Workspaces. Use the chat's trash
button or **Delete archived chat…** menu item. Review the host and confirmation,
then choose **Delete chat**.

A local recovery backup remains. Project files and shared attachments are kept.
This is not secure erasure; backups are not automatically purged. Loaded/busy
chats, reminders, subagents, and parents with linked descendants are refused.
Recently used archives may require restarting Harness and deleting them without
reopening them.

On Mac, the original lock file and directory remain while payload files move to
recovery storage. Do not remove that lock directory while Harness is running.
See [archive recovery details](plugins/dsh-delete-chat/README.md).

## Named hosts, upgrades, and rollback

Each model host has its own ID, provider, credential reference, URL, and pinned
gateway UUID. Reuse an ID to change its address; use a new ID for a new server.
Existing hosts cannot silently be repinned to another server.

```bash
bash "/path/to/dsh-plugins/Install.command" --apply --plugins both \
  --host-id office --host-label "Office model host" --server http://192.168.50.10:8083
```

That address is an example; use your actual private address. Enter keys only in
the hidden prompt, never command arguments or GitHub issues. `--ask-key` replaces
a saved credential. Keys stay in Harness's private credential store, outside the
renderer and package.

New installs use `~/.dsh/plugins/dsh-model-switcher` and
`~/.dsh/plugins/dsh-delete-chat`. The installer recognizes the earlier local-model
and archived-chat plugin names, migrates their profile registrations, and keeps
existing host bindings, credential references, and default selections. It leaves
the old runtime files available for rollback and makes a private transaction
backup under `~/.dsh/backups` before writing.

Quit Harness and run **Uninstall.command** to restore the latest installer
transaction. This can undo an upgrade rather than the first installation.
Rollback refuses to overwrite newer edits. It does not restore deleted chats;
their separate recovery manifests describe those backups.

## Compatibility and tests

Archive deletion accepts audited storage builds `0.2.1-rc.5` / `0.2.2-rc.1` with
exact source hashes. Unknown or modified builds are refused. Do not bypass that
check after updating Harness.

Windows native storage and full deletion/recovery fixtures have been exercised.
The macOS implementation and combined installer are included, but **a live
installation on the target Mac has not yet been completed**. Required installer
preflight checks exercise its actual runtime before enabling archive deletion.
Cross-platform unit tests alone do not establish native Mac compatibility.

See [development](docs/development.md), the [validation record](docs/validation.md),
and the [publication guide](docs/publishing.md). This alpha does not claim completed
native Mac validation.

## License

The plugin code is available under the [MIT License](LICENSE), copyright
2026 Cristian Silva. Included third-party code retains its own license:
[THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md). The installer preserves each
plugin's license notice in its installed runtime folder.
