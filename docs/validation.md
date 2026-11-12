# Validation record — 2026-11-11

## Alpha.3 model discovery and installer prompts

The updated combined suite passed **143 checks** against the installed Windows
CLI packages; the native Darwin contention check remained skipped. This includes
dynamic catalog changes, host isolation, unavailable-model gating, stale response
races, non-reasoning selections, and six real-readline terminal-stream prompt
checks. Typed and edited API-key characters did not appear in captured output.
The installed SettingsForms, Loader, LlmRuntime, and PiAiAdapter classes were
exercised with synthetic in-memory persistence. Model additions became visible,
another provider remained unchanged, and repeated unchanged polls caused no
extra settings writes.

The matching private Windows gateway passed 95 server/runtime/registry checks.
Availability checks inspect configured load/chat recipes, Ollama metadata, and
Flash launch assets without loading models. The dense 27B route remains Ollama;
Flash remains Strata. These gateway checks are separate from the public client
package and do not establish a live Mac installation.

The Mac provider now explicitly uses system-role messages and `max_tokens`,
matching the working Windows gateway request format. Synthetic captures through
the installed adapter verified those wire fields. Model selection sets an effort
only when the model advertises reasoning support; no provider-wide effort is
imposed on a mixed dynamic catalog.

Both original and uncensored 27B models passed live synthetic streamed-reply and
tool-call checks through the installed Desktop `0.2.2-rc.1` adapter and gateway.
The original model also passed the CLI adapter check. No saved conversations or
project files were used. These are connectivity/tool-protocol checks, not a
benchmark or proof that an existing long conversation will complete successfully.

## Alpha.2 baseline

After standalone GitHub bundle integration and path-alias fixes: 122 checks passed against the
installed CLI runtime; one Darwin-only contention test remains skipped on Windows.
Coverage includes license preservation, native and legacy registration migration,
profile isolation, rollback ownership, and independent export packaging.

| Check | Result |
| --- | --- |
| Portable suite without installed Harness | 105 passed; six runtime/platform checks skipped |
| Suite with installed Windows CLI runtime | 122 passed; one native Darwin contention test skipped |
| Native Windows desktop runtime preflight | Three full synthetic checks passed; exit 0 |
| Native bundle metadata and setup gates | Three checks passed against the desktop runtime |
| Both standalone exports with actual CLI and desktop runtimes | Discovery, HTTPS install spec, migration, isolation, idempotence, rollback, and changed-runtime refusal passed |
| Shell syntax | Both command launchers parsed successfully |
| Entry points through directory aliases | Installer, native preflight, and exporter junction/symlink regressions passed |
| Real credential exclusion | Passed during local release packaging; no key included |
| Live Mac installation / UI / Windows connection | Not yet performed |

The Windows desktop build was `0.2.2-rc.1`; CLI was `0.2.1-rc.5`. Test deletions
used only isolated synthetic storage. Installed Windows profiles and user chats
were not modified while preparing this combined suite.

On Mac, the installer must complete its native preflight before enabling archived
chat deletion. That includes real deletion and rollback, disabled-index behavior,
preserved lock inode, and separate-process contention before and after moving
payloads. If it fails, no profiles are changed. Do not report this record as a
completed native Mac test.

Darwin exclusive-rename definitions were checked against Apple's
[stdio header](https://github.com/apple-oss-distributions/xnu/blob/main/bsd/sys/stdio.h)
and [rename manual source](https://github.com/apple-oss-distributions/xnu/blob/main/bsd/man/man2/rename.2).
The portable CI uses the official [checkout](https://github.com/actions/checkout)
and [setup-node](https://github.com/actions/setup-node) actions. The local results
above are separate from GitHub Actions results; see the
[repository Actions](https://github.com/roock3r/dsh-plugins/actions).
