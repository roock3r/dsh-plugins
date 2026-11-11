# Development and verification

Use Node 24 for development. The installer supports compatible Node 22+ Harness
runtimes. Vendored YAML is already included; no dependency installation is needed
for portable tests or packaging.

```bash
npm test
npm run check:public
npm run package
```

Tests without an installed runtime skip installed-Harness fixtures. The portable
tests cover host identity, provider isolation, selection races, permission-block
ownership, loading status, and installer rollback. POSIX filesystem simulations
cover partial moves, conflicts, and journal recovery; they do not replace real
macOS filesystem/locking checks.

## Actual installed Harness fixtures

Set `DSH_DELETE_TEST_PACKAGE_ROOT` to that build's `@deepseek-ai` directory and
`DSH_STORAGE_TEST_PACKAGE_ROOT` to its `dsh-session-persistence-jsonl` subdirectory.
Then run the archive test files or `plugins/dsh-delete-chat/self-test.mjs`
through the matching runtime. For a Mac desktop build:

```bash
APP="/Applications/DeepSeek Harness.app"
BIN="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleExecutable' "$APP/Contents/Info.plist")"
export DSH_DELETE_TEST_PACKAGE_ROOT="$APP/Contents/Resources/app.asar/dsh/node_modules/@deepseek-ai"
export DSH_STORAGE_TEST_PACKAGE_ROOT="$DSH_DELETE_TEST_PACKAGE_ROOT/dsh-session-persistence-jsonl"
ELECTRON_RUN_AS_NODE=1 "$APP/Contents/MacOS/$BIN" plugins/dsh-delete-chat/self-test.mjs
```

The installer runs this native self-test automatically when archive deletion is
selected. It creates canonical temporary directories, instantiates the actual
JSONL/domain/workspace/checkpoint/search services, deletes synthetic chats, checks
backup retention and rollback, and preserves disabled history search. On macOS it
also checks that the original lock inode survives and a second process cannot
acquire it while held, before and after moving payloads. No user profile is loaded.

Do not change runtime hashes to make a failing installation pass. Review the new
build's storage discovery, leases, writer lifecycle, registry caches, query
reconciliation, and public owner-route semantics before supporting it.

## File ownership

- `plugins/dsh-model-switcher`: remote model pill and host bridge.
- `install.mjs`: transactional combined installer and rollback.
- `plugins/dsh-delete-chat`: host/client archive plugin and native preflight.
- `scripts`: publication scan and deterministic release ZIP builder.
- `vendor/yaml`: unmodified licensed parser distribution.

The root `dsh-plugins` package owns shared scripts and the combined installer.
Each plugin has its own package metadata and Harness client-module identity.
`private: true` prevents accidental npm publication; GitHub source sharing is
independent of npm publishing. Existing RPC and host-config names stay compatible.
