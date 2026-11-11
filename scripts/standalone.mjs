/** Build standalone GitHub mirrors from the canonical, scanned workspace. */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { releaseFiles, root, checkPublicContents } from './release-files.mjs';
import { makeZip } from './zip.mjs';

export const standalonePlugins = ['dsh-delete-chat', 'dsh-model-switcher'];
const canonicalRepository = 'https://github.com/roock3r/dsh-plugins';
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const json = value => Buffer.from(JSON.stringify(value, null, 2) + '\n');
function committedSource() {
  try {
    const options = { cwd: root, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] };
    if (execFileSync('git', ['status', '--porcelain', '--untracked-files=all'], options).trim()) return null;
    const commit = execFileSync('git', ['rev-parse', 'HEAD'], options).trim();
    return /^[a-f0-9]{40}$/.test(commit) ? commit : null;
  } catch { return null; }
}

export function standaloneFiles(plugin) {
  if (!standalonePlugins.includes(plugin)) throw new Error('Unknown standalone plugin');
  const source = new Map(releaseFiles().map(name => [name, fs.readFileSync(path.join(root, name))]));
  checkPublicContents(source);
  const entries = new Map(), prefix = `plugins/${plugin}/`;
  const copy = (from, to = from) => {
    if (!source.has(from)) throw new Error(`Missing standalone source: ${from}`);
    entries.set(to, source.get(from));
  };
  for (const [name] of source) {
    if (name.startsWith(prefix)) copy(name, name.slice(prefix.length));
    if (name.startsWith('vendor/yaml/')) copy(name);
  }
  for (const name of ['install.mjs', 'Install.command', 'Uninstall.command', 'LICENSE',
    'THIRD-PARTY-NOTICES.md', '.gitignore', '.gitattributes', 'docs/validation.md']) copy(name);
  if (plugin === 'dsh-model-switcher') copy('docs/gateway-protocol.md');
  entries.set('docs/plugin-details.md', Buffer.from(source.get(`${prefix}README.md`).toString('utf8')
    .replaceAll('../../docs/', '').replaceAll('/path/to/dsh-plugins/', `/path/to/${plugin}/`)
    .replace('Use the root `Install.command` for both plugins, or:', 'Use the included `Install.command` to configure this plugin:')));
  copy(`docs/standalone/${plugin}.md`, 'README.md');
  copy('scripts/standalone-smoke.mjs', 'distribution.test.mjs');
  const metadata = JSON.parse(source.get(`${prefix}package.json`));
  metadata.repository = { type: 'git', url: `https://github.com/roock3r/${plugin}.git` };
  metadata.homepage = `https://github.com/roock3r/${plugin}#readme`;
  metadata.bugs = { url: `https://github.com/roock3r/${plugin}/issues` };
  metadata.scripts = { ...metadata.scripts, test: plugin === 'dsh-delete-chat'
    ? 'node --test distribution.test.mjs test/*.test.mjs' : 'node --test distribution.test.mjs',
    setup: 'bash Install.command --apply', 'setup:check': 'bash Install.command --check' };
  entries.set('package.json', json(metadata));
  entries.set('installer-distribution.json', json({ version: 1, plugins: { [plugin]: '.' } }));
  const sources = [...source].map(([name, bytes]) => ({ path: name, sha256: sha256(bytes) }));
  const canonicalCommit = committedSource();
  const sourceTreeSha256 = sha256(json(sources));
  entries.set('SOURCE.json', json({ version: 1, canonicalRepository, canonicalCommit, plugin,
    canonicalDirectory: `plugins/${plugin}`, sourceTreeSha256, sources }));
  entries.set('SOURCE.md', Buffer.from(`# Generated standalone distribution\n\nThis repository is generated from [the canonical DSH workspace](${canonicalRepository}).\n\nEdit plugin code and the shared installer in that workspace, then run\n\`npm run package:standalone\`. Do not maintain a divergent copy here.\n\`SOURCE.json\` records the exact canonical source-file hashes used for this export.\nThe exporter includes one plugin and a self-contained installer; setup does not\nfetch the combined repository or another plugin.\n\nThe package versions remain compatible with existing installations. Release tags\nand uploaded asset hashes should be checked against the generated receipt.\n`));
  entries.set('.github/workflows/test.yml', Buffer.from(`name: Standalone checks\non: [push, pull_request]\npermissions:\n  contents: read\njobs:\n  portable:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@v6\n      - uses: actions/setup-node@v6\n        with:\n          node-version: '24'\n      - run: npm test\n      - run: bash -n Install.command Uninstall.command\n`));
  const scan = checkPublicContents(entries);
  return { plugin, metadata, entries, scan, sourceTreeSha256, canonicalCommit };
}

function exportDirectory(plugin, entries) {
  const parent = path.resolve(root, 'dist', 'repositories'), destination = path.resolve(parent, plugin);
  if (path.dirname(destination) !== parent || !standalonePlugins.includes(path.basename(destination))) throw new Error('Unsafe export destination');
  for (const candidate of [path.join(root, 'dist'), parent, destination]) {
    if (fs.existsSync(candidate) && (fs.lstatSync(candidate).isSymbolicLink() || !fs.lstatSync(candidate).isDirectory())) throw new Error('Linked or invalid export destination');
  }
  if (fs.existsSync(path.join(destination, '.git'))) throw new Error('Refusing to replace a Git working tree; publish a copy of this generated export');
  if (fs.existsSync(destination)) {
    const receipt = path.join(destination, 'SOURCE.json');
    if (!fs.existsSync(receipt) || JSON.parse(fs.readFileSync(receipt, 'utf8')).plugin !== plugin) throw new Error('Refusing to replace an unrecognized export directory');
    if (fs.realpathSync(destination) !== destination) throw new Error('Noncanonical export destination');
    fs.rmSync(destination, { recursive: true });
  }
  fs.mkdirSync(destination, { recursive: true });
  for (const [name, bytes] of entries) {
    const filename = path.join(destination, name);
    fs.mkdirSync(path.dirname(filename), { recursive: true });
    fs.writeFileSync(filename, bytes, { mode: name.endsWith('.command') ? 0o755 : 0o644 });
  }
  return destination;
}

export function buildStandalone(plugin) {
  const result = standaloneFiles(plugin);
  const zip = makeZip(result.entries, plugin);
  const destination = exportDirectory(plugin, result.entries);
  const filename = `${plugin}-mac.zip`;
  const receipt = { filename, plugin, version: result.metadata.version, bytes: zip.length,
    entries: result.entries.size, sha256: sha256(zip), sourceTreeSha256: result.sourceTreeSha256, canonicalCommit: result.canonicalCommit,
    scan: result.scan, macNativeInstallation: 'pending; live setup has not been verified on the target Mac' };
  fs.writeFileSync(path.join(root, 'dist', filename), zip);
  fs.writeFileSync(path.join(root, 'dist', `${plugin}-verification.json`), json(receipt));
  return { ...receipt, repositoryDirectory: path.relative(root, destination).split(path.sep).join('/') };
}

function isEntryPoint() {
  try { return Boolean(process.argv[1]) && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url)); }
  catch { return false; }
}

if (isEntryPoint()) {
  for (const plugin of standalonePlugins) console.log(JSON.stringify(buildStandalone(plugin)));
}
