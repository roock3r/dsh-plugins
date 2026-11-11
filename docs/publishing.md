# GitHub publication

The approved destination is the **public** repository
[`roock3r/dsh-plugins`](https://github.com/roock3r/dsh-plugins), with the plugin code
under the [MIT License](../LICENSE), copyright 2026 Cristian Silva.

The prepared suite release is **`v0.1.0-alpha.1`**, an experimental prerelease.
The repository contains `dsh-delete-chat` and `dsh-model-switcher` plus their
combined Mac installer. Existing plugin package versions remain `1.0.0` and
`2.1.0`; the suite version identifies this initial public distribution.

Verify the remote commit, release tag, and uploaded asset hashes on GitHub before
reporting a completed publication. Keep the release contents and package receipt
aligned with the tagged source.

Before publishing:

- For an experimental source release, state that native Mac installation remains
  pending. Before a stable Mac release, record its Harness version, source hashes,
  native preflight receipt, and UI checks. Exclude private hostnames and chat text.
- Retain the root and plugin MIT notices and YAML's separate ISC notice.
- Run tests, then `node scripts/check-public.mjs` and `node scripts/package.mjs`.
- Review the allowlisted ZIP and Git diff. Exclude profiles, keys, weights, logs,
  chat histories, databases, and private backup manifests.
- Publish the prepared version as a GitHub **prerelease**, retaining the native
  Mac caveat. Verify the repository visibility, tag commit, CI result, and ZIP
  SHA-256 against the generated package receipt.

The model plugin requires an existing compatible gateway v2. Gateway software,
inference runtimes, and weights are not bundled. Describe that prerequisite in
releases; this is not a generic Ollama installer.

CI unit tests without Harness are not native runtime proof. The installer
preflight and opt-in native fixture suite provide that evidence on the target OS.

Public sharing does not imply a stable or generic deployment. The model gateway
is an external prerequisite, while archive deletion accepts only audited Harness
builds. Native Mac installation remains pending and must not be described as
completed based on Windows fixtures or a passing generic CI job.
