# Future GitHub publication

The repository and ZIP are prepared locally. Nothing is published; a public
license has not yet been selected.

Before publishing:

- For an experimental source release, state that native Mac installation remains
  pending. Before a stable Mac release, record its Harness version, source hashes,
  native preflight receipt, and UI checks. Exclude private hostnames and chat text.
- Choose the project license and repository owner/name. Retain YAML's ISC notice.
- Run tests, then `node scripts/check-public.mjs` and `node scripts/package.mjs`.
- Review the allowlisted ZIP and Git diff. Exclude profiles, keys, weights, logs,
  chat histories, databases, and private backup manifests.
- Review the concrete repository/release contents before publishing.

The model plugin requires an existing compatible gateway v2. Gateway software,
inference runtimes, and weights are not bundled. Describe that prerequisite in
releases; this is not a generic Ollama installer.

CI unit tests without Harness are not native runtime proof. The installer
preflight and opt-in native fixture suite provide that evidence on the target OS.

Suggested repository: `roock3r/dsh-plugins`, containing two separately named
packages (`dsh-delete-chat` and `dsh-model-switcher`) and one combined installer.
The connected account lookup found no repository at that name during preparation.
Visibility and project license are publication decisions, not technical blockers
to the local workspace reorganization. No remote has been created by this work.
