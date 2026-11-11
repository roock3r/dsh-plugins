# Standalone plugin distributions

The canonical source is `roock3r/dsh-plugins`. The public repositories
`roock3r/dsh-delete-chat` and `roock3r/dsh-model-switcher` are generated mirrors,
each containing one root plugin package and its complete local Mac installer.
Registering a GitHub bundle creates a dormant plugin row; setup completes the
required host configuration or native deletion preflight before activating it.

Build from the canonical workspace:

```bash
npm test
npm run check:public
npm run package:standalone
```

The exporter writes `dist/repositories/<plugin>` for source publication,
`dist/<plugin>-mac.zip` for installation, and `dist/<plugin>-verification.json`
with the archive hash. `SOURCE.json` in each mirror records exact canonical file
hashes and the canonical commit for a clean checkout; `SOURCE.md` explains
ownership. Exports contain no timestamps or local paths. Repeated builds of the
same committed source produce identical ZIP bytes. Uncommitted previews record
a null commit and must be rebuilt after committing before publication.

Root `package.json` metadata points to the individual repository, and runtime
entrypoints and bundle patches live at its root. `installer-distribution.json`
restricts the shared installer to that plugin. Each installer keeps its own
latest-transaction receipt; rollback cannot accidentally select another plugin's
transaction. The other plugin's runtime is not included. The YAML parser and its
license are retained, and launchers are executable with LF line endings.

If the GitHub bundle is present, standalone setup activates only profiles that
select that verified bundle. Without a native bundle, ZIP-only setup retains the
direct-file installation path. Remove a configured native bundle only after
rolling back its valid installer transaction, so an enabled profile override is
not left pointing at a removed package.

Copy the completed source export to a separate publishing checkout; do not edit
generated files as canonical source. The exporter refuses to replace a Git
working tree or an unrecognized output directory. Regenerate after changing
source, tests, or documentation, then verify remote commit/tag and uploaded ZIP
hash against the final receipt. Do not modify the build afterward and reuse an
old verification receipt.

Each mirror includes portable checks and CI. Those checks run with synthetic
storage where available; they do not prove a live Mac installation. Preserve
the native Mac caveat until actual target-machine validation is recorded.
