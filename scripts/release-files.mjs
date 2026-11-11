import fs from 'node:fs';
import path from 'node:path';
export const root = path.resolve(import.meta.dirname, '..');
const files = ['Install.command', 'Uninstall.command', 'package.json', 'install.mjs',
  'README.md', 'AGENTS.md',
  'THIRD-PARTY-NOTICES.md', 'portable.test.mjs', 'suite-installer.test.mjs',
  '.gitignore', '.gitattributes'];
const directories = ['docs', 'scripts', '.github', 'plugins/dsh-model-switcher', 'plugins/dsh-delete-chat', 'vendor/yaml'];
const forbidden = /(?:^|\/)(?:node_modules|\.dsh|backups|artifacts)(?:\/|$)|\.(?:log|sqlite(?:-\w+)?|jsonl|zip|key|pem|gguf|exe|dll)$|(?:^|\/)(?:\.env(?:\..*)?|\.credentials\.yaml|local-model-switch-client\.json|validation\.json)$/i;
export function releaseFiles() {
  const result = [...files];
  const canonicalRoot = fs.realpathSync(root);
  const inside = relative => {
    const resolved = fs.realpathSync(path.join(root, relative));
    const suffix = path.relative(canonicalRoot, resolved);
    if (!suffix || suffix === '..' || suffix.startsWith(`..${path.sep}`) || path.isAbsolute(suffix)) throw new Error(`Release path escaped source root: ${relative}`);
  };
  function visit(relative) {
    inside(relative);
    const directory = fs.lstatSync(path.join(root, relative));
    if (directory.isSymbolicLink() || !directory.isDirectory()) throw new Error(`Linked or invalid release directory: ${relative}`);
    for (const entry of fs.readdirSync(path.join(root, relative), { withFileTypes: true })) {
      const name = `${relative}/${entry.name}`;
      if (forbidden.test(name) || entry.isSymbolicLink()) throw new Error(`Private or linked artifact in release tree: ${name}`);
      if (entry.isDirectory()) visit(name);
      else if (entry.isFile()) result.push(name);
      else throw new Error(`Unsupported artifact: ${name}`);
    }
  }
  for (const directory of directories) visit(directory);
  for (const name of result) {
    inside(name);
    const file = fs.lstatSync(path.join(root, name));
    if (file.isSymbolicLink() || !file.isFile()) throw new Error(`Linked or invalid release file: ${name}`);
  }
  return result.sort();
}
export function publicCheck() {
  const entries = releaseFiles();
  const privatePatterns = [
    /[A-Z]:[\\/]Users[\\/](?!runneradmin\b)[A-Za-z][^\\/\s"']*[\\/]/i,
    /\/Users\/(?!example\b|runner\b|Shared\b)[A-Za-z][^/\s"']*\//,
    /192\.168\.1\.(?:253|87)(?!\d)/,
    /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
    /\bsk-[A-Za-z0-9]{24,}\b/,
  ];
  const localSecret = process.env.DSH_RELEASE_SECRET_SCAN;
  for (const name of entries) {
    const content = fs.readFileSync(path.join(root, name), 'utf8');
    // This scanner contains its own deny patterns, not machine configuration.
    if (name !== 'scripts/release-files.mjs' && privatePatterns.some(pattern => pattern.test(content))) throw new Error(`Private-looking content found in ${name}`);
    if (localSecret && content.includes(localSecret)) throw new Error(`Credential exclusion failed in ${name}`);
    if (name.endsWith('.command') && content.includes('\r')) throw new Error(`Command file needs LF line endings: ${name}`);
  }
  return { ok: true, entries: entries.length, exactCredentialScan: localSecret ? 'passed' : 'not supplied' };
}
