# dsh-delete-chat

Confirmed removal of cold archived chats from the **Harness chat-storage host**.
Model-provider location is independent: Mac-local Harness using Windows inference
still deletes Mac-local chats. A remote client connected to a Windows Harness
host operates on that Windows host's chats.

## Install and use

Use the root `Install.command`, optionally with `--apply --plugins archive-delete`.
Archive-only mode needs no gateway or key. Native synthetic deletion/recovery
checks must pass before profiles are changed.

Choose **View options → Archived only**, then the trash button or **Delete archived
chat…** menu. The dialog checks eligibility; deletion requires its fresh single-use
confirmation token. Cancel never deletes a chat.

Loaded chats, active readers/jobs, reminders, subagents, and parents with linked
descendants are refused. Restart Harness to release a recently used archive and
delete without reopening it. The plugin does not interrupt work or restart the app.
Unknown builds and old chat formats are also refused.

## Runtime support

macOS and Windows, current session format 4, exact audited source builds
`0.2.1-rc.5` / `0.2.2-rc.1`, with runtime method verification. Native Mac verification
occurs during install; package inclusion does not imply installation on a Mac.

Package, client module, and plugin ID: `dsh-delete-chat`.
Configuration names code packages, not chat storage:

```json
{"packageRoot":"/Applications/DeepSeek Harness.app/Contents/Resources/app.asar/dsh/node_modules/@deepseek-ai"}
```

The installer discovers this path. CLI profiles require the actual CLI package
root. No inference URL, key, port, or app-bundle patch is used.

The old `archived-chat-delete` registration is migrated by the suite installer.
The existing RPC namespace and `.archived-chat-delete-backups` recovery directory
remain compatible; a package rename does not relocate or remove chat backups.

## Transaction

1. Owner-only routes validate archive status, activity, relationships, storage
   revision, paths, and confirmation. Workspace mutations are serialized.
2. The plugin acquires the storage writer lease and rechecks eligibility.
3. Windows moves the entire per-chat directory to recovery with a no-replace
   native operation on the same volume.
4. Mac preserves the original directory and `session.lock` inode. Payloads move
   individually with exclusive renames and a recovery journal, historical logs
   before the current log. Harness ignores a directory containing only its lock.
5. Checkpoints, workspace membership, and audited caches are removed. Enabled
   search reconciles normally. Disabled search stays disabled; its next enabled
   search removes stale entries before returning results.
6. Absence is verified, the empty writer is released, completion recorded, and
   the real client session list refreshed.

Project files/shared attachments remain. There is no bulk delete, backup purge,
secure erasure, or in-app Undo.

## Recovery

Backups live in `.archived-chat-delete-backups` beside session storage. The success
dialog gives the precise path. JSON manifests record original paths, payload
inventory, and metadata; Mac receipts also identify the per-file move journal.

Failures after moving data attempt rollback without overwriting unrelated files.
A crash or conflict may need manual recovery. Keep the backup/manifest and stop
**all** Harness processes using that storage before repair. Do not retry until
the recovery state is reviewed.

On Mac, restore payloads into the retained original directory as recorded in the
manifest. Do not replace its lock directory with the backup, remove an in-use
lock, or overwrite replacement artifacts. Windows manifests describe a whole
directory move. No general automatic crash-recovery tool is provided.

## Native preflight

`self-test.mjs` creates its own temporary storage, domains, workspace, and search
index. It loads no user profile and uses no model endpoint. The installer requires
its successful JSON receipt before activation.

```bash
DSH_DELETE_TEST_PACKAGE_ROOT="/actual/@deepseek-ai" node self-test.mjs
```

For Electron ASAR packages use Harness's bundled executable with
`ELECTRON_RUN_AS_NODE=1`; plain Node cannot read ASAR as a directory. See the root
development guide for unit and native fixtures. Only synthetic chats are deleted.
