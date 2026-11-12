# DSH plugins maintenance

- `plugins/dsh-delete-chat` and `plugins/dsh-model-switcher` are separate Harness
  packages. Keep package names, backend exports, and client module IDs aligned.
- The root owns the combined Mac installer, tests, vendored YAML, and release ZIP.
- Preserve recognized legacy registration migrations, credential references,
  host bindings, RPC namespaces, and rollback compatibility.
- Never test deletion on user chats. Use isolated synthetic storage. Never bypass
  source-hash, ownership, cold-session, path, or native-lock checks to pass tests.
- Changes to Mac storage need actual native preflight evidence. Windows mocks
  and skipped Mac tests must not be described as a native Mac validation.
- Do not read user profiles or credentials for tests. Do not package keys, logs,
  weights, chat histories, database files, or installation/recovery backups.
- Run `npm test`, `npm run check:public`, and `npm run package` as appropriate.
  Installed-runtime tests use the explicit environment paths in the development
  guide. Verify the ZIP includes executable LF command files and both plugins.
- Update plugin READMEs and recovery documentation when behavior changes. Treat
  the external gateway v2 dependency, server availability checks, and registered
  load/chat recipes as explicit limits. Discovery must never load weights.
- Keep vendored third-party files and their notices intact. Choose a project
  license and publication destination before publicly releasing this source.
