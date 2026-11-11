import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import readline from 'node:readline';
import { Writable } from 'node:stream';
import { isDeepStrictEqual } from 'node:util';
import YAML from './vendor/yaml/dist/index.js';

const options = { customTags: [{ tag: 'tag:yaml.org,2002:js', resolve: value => value }] };
const pluginId = 'dsh-model-switcher';
const modelPluginIds = new Set([pluginId, 'windows-model-switch-client', 'local-model-switch-client']);
const runtimeFiles = ['package.json', 'LICENSE', 'index.mjs', 'client.js', 'catalog.mjs', 'settings.mjs', 'cordis.patch.yml'];
const archiveId = 'dsh-delete-chat';
const archivePluginIds = new Set([archiveId, 'archived-chat-delete']);
const archiveRuntimeFiles = ['package.json', 'LICENSE', 'index.mjs', 'client.js', 'service.mjs', 'storage-adapter.mjs', 'posix-quarantine.mjs', 'cordis.patch.yml'];
const requireValue = (condition, message) => { if (!condition) throw new Error(message); };

/** Generated standalone exports contain one root plugin; the source suite has no manifest. */
export function readInstallerDistribution(sourceRoot = import.meta.dirname) {
  const filename = path.join(sourceRoot, 'installer-distribution.json');
  if (!fs.existsSync(filename)) return Object.freeze({ id: 'dsh-plugins', defaultSelection: 'both',
    roots: Object.freeze({ [pluginId]: `plugins/${pluginId}`, [archiveId]: `plugins/${archiveId}` }),
    receiptName: 'companion-plugins-last-install.json', backupPrefix: 'companion-plugins' });
  let manifest;
  try { manifest = JSON.parse(fs.readFileSync(filename, 'utf8')); }
  catch { throw new Error('Invalid standalone installer distribution manifest.'); }
  requireValue(manifest?.version === 1 && Object.keys(manifest).length === 2 &&
    manifest.plugins && typeof manifest.plugins === 'object' && !Array.isArray(manifest.plugins),
  'Invalid standalone installer distribution manifest.');
  const entries = Object.entries(manifest.plugins);
  requireValue(entries.length === 1 && [pluginId, archiveId].includes(entries[0][0]) && entries[0][1] === '.',
    'A standalone installer must contain exactly one supported plugin at its repository root.');
  const id = entries[0][0];
  return Object.freeze({ id, defaultSelection: id === pluginId ? 'model-switch' : 'archive-delete',
    roots: Object.freeze({ [id]: '.' }), receiptName: `${id}-last-install.json`, backupPrefix: id });
}

export const installerDistribution = readInstallerDistribution();
const sourceFile = (id, filename, sourceRoot = import.meta.dirname) => {
  requireValue(Object.hasOwn(installerDistribution.roots, id), `This installer does not include ${id}.`);
  return path.join(sourceRoot, installerDistribution.roots[id], filename);
};
const loadSource = (id, filename) => import(pathToFileURL(sourceFile(id, filename)).href);
const { MODELS, MODEL_IDS, hostProvider, hostCredentialRef } = installerDistribution.roots[pluginId]
  ? await loadSource(pluginId, 'catalog.mjs') : {};
const { validateGatewayURL, validateHost, validateClientConfig } = installerDistribution.roots[pluginId]
  ? await loadSource(pluginId, 'settings.mjs') : {};
const { SUPPORTED_STORAGE_BUILDS } = installerDistribution.roots[archiveId]
  ? await loadSource(archiveId, 'storage-adapter.mjs') : {};
const cleanupHashes = {
  'dsh-workspace': '931ca0cb10c5102066c7723690a887f0e6e8e7ab0ffdee1a782686745b0b934f',
  'dsh-session-query': '76ce2944e561c12f48b5e240d68cafe54ce6d667b1d20722e6939ed834489939',
  'dsh-session-query-sqlite': 'dbecf83320e10d93d735b3d01384ab817a0b90102ccecb0a22c013c71dfe70a0',
  'dsh-session-projection-cache': 'faf307dce5db2fb7ff58b4c7d9e544fc7cad5de2f270a89326a8d7bb2bda9c80',
};
const sha = value => createHash('sha256').update(value).digest('hex');

export function pluginSelection(value = installerDistribution.defaultSelection) {
  requireValue(['both', 'model-switch', 'archive-delete'].includes(value), 'Use --plugins both, model-switch, or archive-delete.');
  const selected = { name: value, modelSwitch: value !== 'archive-delete', archiveDelete: value !== 'model-switch' };
  requireValue((!selected.modelSwitch || installerDistribution.roots[pluginId]) &&
    (!selected.archiveDelete || installerDistribution.roots[archiveId]),
  `This distribution installs only ${installerDistribution.id}.`);
  return selected;
}

/** Read only. A native package must match this setup download before it is enabled. */
export function discoverNativeBundle(profile, id, { sourceRoot = import.meta.dirname } = {}) {
  requireValue([pluginId, archiveId].includes(id), 'Unknown plugin package.');
  const profileDir = path.dirname(profile.filename), filename = path.join(profileDir, 'package.json');
  if (!fs.existsSync(filename)) return null;
  let manifest;
  try { manifest = JSON.parse(fs.readFileSync(filename, 'utf8')); }
  catch { throw new Error(`The ${profile.name} profile package manifest is invalid.`); }
  requireValue(manifest && typeof manifest === 'object' && !Array.isArray(manifest),
    `The ${profile.name} profile package manifest is invalid.`);
  const dependencies = manifest?.dependencies || {};
  const bundles = manifest?.dsh?.profile?.bundles || [];
  requireValue(dependencies && typeof dependencies === 'object' && !Array.isArray(dependencies) && Array.isArray(bundles),
    `The ${profile.name} profile package manifest is invalid.`);
  const dependency = Object.hasOwn(dependencies, id), selected = bundles.filter(name => name === id);
  if (!dependency && !selected.length) return null;
  requireValue(!(dependency && typeof dependencies[id] === 'string' && selected.length === 0),
    `Select Enable now for ${id} in Harness Plugins, then quit Harness and rerun setup. The plugin stays off until setup completes.`);
  requireValue(dependency && typeof dependencies[id] === 'string' && selected.length === 1,
    `The ${id} dependency and selected bundle do not agree in ${profile.name}. Repair that installation before setup.`);
  const packageDir = path.join(profileDir, 'node_modules', id);
  const failure = `The native ${id} package does not match this setup download. Use the same verified release and review its bundle before continuing.`;
  try {
    const installed = JSON.parse(fs.readFileSync(path.join(packageDir, 'package.json'), 'utf8'));
    const supplied = JSON.parse(fs.readFileSync(sourceFile(id, 'package.json', sourceRoot), 'utf8'));
    requireValue(installed.name === id && supplied.name === id && installed.dsh?.bundle?.patch === './cordis.patch.yml', failure);
    for (const field of ['version', 'type', 'main', 'exports', 'dsh']) requireValue(isDeepStrictEqual(installed[field], supplied[field]), failure);
    const patch = YAML.parse(fs.readFileSync(path.join(packageDir, 'cordis.patch.yml'), 'utf8'));
    const loaderId = `${id}-bundle`;
    requireValue(isDeepStrictEqual(patch, [{ insert: [{ id: loaderId, name: id, disabled: true, config: { setupRequired: true } }] }]), failure);
    for (const name of (id === pluginId ? runtimeFiles : archiveRuntimeFiles).filter(name => name !== 'package.json' && name !== 'LICENSE')) {
      requireValue(fs.readFileSync(path.join(packageDir, name)).equals(fs.readFileSync(sourceFile(id, name, sourceRoot))), failure);
    }
    return Object.freeze({ id, loaderId, packageDir: fs.realpathSync(packageDir) });
  } catch (error) {
    if (error.message === failure) throw error;
    throw new Error(failure);
  }
}

/** Native standalone setup follows the profiles selected in Harness's plugin manager. */
export function selectInstallProfiles(profiles, { sourceRoot = import.meta.dirname } = {}) {
  if (installerDistribution.id === 'dsh-plugins') return profiles;
  const nativeProfiles = profiles.filter(profile => discoverNativeBundle(profile, installerDistribution.id, { sourceRoot }));
  return nativeProfiles.length ? nativeProfiles : profiles;
}

/** Convert one recognized file registration into an override of a verified dormant bundle. */
function configureNativeRegistration(doc, before, expected, { nativeBundle, id, ids, pluginPath, legacyPath, plugin, configKeys }) {
  requireValue(nativeBundle.id === id && nativeBundle.loaderId === `${id}-bundle`, 'Invalid native bundle proof.');
  const validConfig = config => config === undefined || (config !== null && typeof config === 'object' && !Array.isArray(config));
  const ownIds = new Set([...ids, nativeBundle.loaderId]);
  const ownPaths = new Set([pathToFileURL(path.join(pluginPath, 'index.mjs')).href,
    pathToFileURL(path.join(path.dirname(pluginPath), legacyPath, 'index.mjs')).href]);
  function inspect(value, location = [], ancestors = new Set()) {
    if (!value || typeof value !== 'object') return;
    requireValue(!ancestors.has(value), 'Circular plugin configuration requires manual review.');
    if (!Array.isArray(value) && (ownIds.has(value.id) || value.name === id || ownPaths.has(value.name))) {
      const direct = location.length === 1 && Number.isInteger(location[0]);
      const insertion = location.length === 3 && Number.isInteger(location[0]) && location[1] === 'insert' && Number.isInteger(location[2]);
      requireValue(direct || insertion, 'A nested plugin registration requires manual review before native setup.');
      requireValue(!ownPaths.has(value.name) || ids.has(value.id),
        'An unexpected plugin ID points to this runtime. Review it before native setup.');
    }
    const next = new Set(ancestors); next.add(value);
    if (Array.isArray(value)) value.forEach((child, index) => inspect(child, [...location, index], next));
    else for (const [key, child] of Object.entries(value)) inspect(child, [...location, key], next);
  }
  inspect(before);
  requireValue(!before.some(row => (row.name === id && row.id !== nativeBundle.loaderId) ||
    (row.insert || []).some(entry => entry.name === id)),
  'An unexpected registration already uses this native package. Review it before setup.');
  const direct = before.flatMap((row, i) => ownIds.has(row.id) ? [i] : []);
  requireValue(direct.length <= 1, 'Duplicate native plugin overrides require manual review.');
  if (direct.length) {
    const existing = before[direct[0]];
    requireValue(existing.id === nativeBundle.loaderId && (existing.name === undefined || existing.name === id) &&
      Object.keys(existing).every(key => ['id', 'name', 'disabled', 'config'].includes(key)) &&
      (existing.disabled === undefined || typeof existing.disabled === 'boolean') &&
      validConfig(existing.config) &&
      Object.keys(existing.config || {}).every(key => configKeys.includes(key) || (key === 'setupRequired' && existing.config[key] === true)),
    'Unexpected native plugin override. Review it before setup.');
  }
  const found = before.flatMap((row, i) => (row.insert || []).flatMap((entry, j) => ownIds.has(entry.id) ? [[i, j]] : []));
  requireValue(found.length <= 1, 'Duplicate file/native plugin registrations require manual review.');
  if (found.length) {
    const [i, j] = found[0], entry = before[i].insert[j];
    const knownPath = entry.name === pathToFileURL(path.join(pluginPath, 'index.mjs')).href ||
      (entry.id !== id && entry.name === pathToFileURL(path.join(path.dirname(pluginPath), legacyPath, 'index.mjs')).href);
    requireValue(ids.has(entry.id) && knownPath &&
      Object.keys(entry).every(key => ['id', 'name', 'config'].includes(key)) &&
      validConfig(entry.config) &&
      Object.keys(entry.config || {}).every(key => configKeys.includes(key)),
    'The existing file plugin has an unexpected location or configuration. Review it before native setup.');
    expected[i].insert.splice(j, 1); doc.deleteIn([i, 'insert', j]);
    if (!expected[i].insert.length && Object.keys(expected[i]).length === 1) { expected.splice(i, 1); doc.delete(i); }
  }
  const index = expected.findIndex(row => row.id === nativeBundle.loaderId);
  if (index < 0) { expected.push(plugin); doc.add(plugin); }
  else { expected[index] = plugin; doc.set(index, plugin); }
}

export function configureArchiveProfile(source, { pluginPath, packageRoot, nativeBundle }) {
  requireValue(typeof packageRoot === 'string' && path.isAbsolute(packageRoot), 'The archive plugin needs an absolute verified Harness package directory.');
  const doc = YAML.parseDocument(source || '[]\n', options);
  requireValue(doc.errors.length === 0, 'Harness profile contains invalid YAML.');
  const before = doc.toJS();
  requireValue(Array.isArray(before), 'Harness profiles must contain a patch list.');
  const expected = structuredClone(before);
  const plugin = nativeBundle
    ? { id: nativeBundle.loaderId, name: archiveId, disabled: false, config: { packageRoot } }
    : { id: archiveId, name: pathToFileURL(path.join(pluginPath, 'index.mjs')).href, config: { packageRoot } };
  if (nativeBundle) configureNativeRegistration(doc, before, expected, { nativeBundle, id: archiveId, ids: archivePluginIds,
    pluginPath, legacyPath: 'archived-chat-delete', plugin, configKeys: ['packageRoot'] });
  else {
    requireValue(!before.some(row => archivePluginIds.has(row.id) || row.id === `${archiveId}-bundle`), 'Unexpected direct archive-plugin override.');
    const found = before.flatMap((row, i) => (row.insert || []).flatMap((item, j) => archivePluginIds.has(item.id) ? [[i, j]] : []));
    requireValue(found.length <= 1, 'Duplicate archive plugins require manual review.');
    if (found.length) {
      const [i, j] = found[0], existing = before[i].insert[j];
      const knownLegacy = existing.id === 'archived-chat-delete' && existing.name ===
        pathToFileURL(path.join(path.dirname(pluginPath), 'archived-chat-delete', 'index.mjs')).href;
      requireValue((existing.name === plugin.name || knownLegacy) && Object.keys(existing.config || {}).every(key => key === 'packageRoot'),
        'The archive plugin has an unexpected location or configuration. Review it before upgrading.');
      expected[i].insert[j] = plugin; doc.setIn([i, 'insert', j], plugin);
    } else { expected.push({ insert: [plugin] }); doc.add({ insert: [plugin] }); }
  }
  const output = String(doc);
  requireValue(JSON.stringify(YAML.parse(output, options)) === JSON.stringify(expected), 'Unexpected archive profile rewrite.');
  requireValue((output.match(/!!js\b/g) || []).length === (source.match(/!!js\b/g) || []).length, 'JavaScript configuration tags changed.');
  return { output, changed: JSON.stringify(before) !== JSON.stringify(expected) };
}

export function hasArchivePlugin(source) {
  const doc = YAML.parseDocument(source, options);
  requireValue(doc.errors.length === 0 && Array.isArray(doc.toJS()), 'Harness profile contains invalid YAML.');
  const known = id => archivePluginIds.has(id) || id === `${archiveId}-bundle`;
  return doc.toJS().some(row => known(row.id) || (row.insert || []).some(item => known(item.id)));
}

/** Read installed code only. Unknown builds never receive an enabled deletion plugin. */
export function verifyArchivePackages(packageRoot) {
  requireValue(installerDistribution.roots[archiveId], 'This installer does not include archived-chat deletion.');
  requireValue(typeof packageRoot === 'string' && path.isAbsolute(packageRoot), 'An absolute Harness package directory is required.');
  const alternative = installerDistribution.roots[pluginId] ? ' or use --plugins model-switch' : '';
  const failure = `This installed Harness build has not been verified for archived-chat deletion. Update the plugin adapter${alternative}; no files were changed.`;
  try {
    const jsonl = path.join(packageRoot, 'dsh-session-persistence-jsonl');
    const metadata = JSON.parse(fs.readFileSync(path.join(jsonl, 'package.json'), 'utf8'));
    requireValue(metadata.name === '@deepseek-ai/dsh-session-persistence-jsonl' &&
      SUPPORTED_STORAGE_BUILDS[metadata.version] === sha(fs.readFileSync(path.join(jsonl, 'lib/index.js'))), failure);
    for (const [name, expected] of Object.entries(cleanupHashes)) {
      requireValue(sha(fs.readFileSync(path.join(packageRoot, name, 'lib/index.js'))) === expected, failure);
    }
    return { packageRoot, storageVersion: metadata.version, sourceHashesVerified: true };
  } catch (error) {
    if (error.message === failure) throw error;
    throw new Error(`${failure} The selected package directory could not be inspected.`);
  }
}

/** Native smoke test uses synthetic temporary storage and never a user chat. */
export function runArchiveSmokeTest(packageRoot, { sourceRoot = import.meta.dirname, runtime = process.execPath, runner = execFileSync } = {}) {
  let output;
  try {
    output = runner(runtime, [sourceFile(archiveId, 'self-test.mjs', sourceRoot)], {
      env: { ...process.env, DSH_DELETE_TEST_PACKAGE_ROOT: packageRoot }, encoding: 'utf8',
      timeout: 90_000, maxBuffer: 512 * 1024, windowsHide: true,
    });
  } catch { throw new Error('The archived-chat safety test failed or timed out. No profiles were changed. Review the supported Harness version.'); }
  let proof;
  try { proof = JSON.parse(String(output).trim().split(/\r?\n/).at(-1)); }
  catch { throw new Error('The archived-chat safety test returned no valid proof. No profiles were changed.'); }
  requireValue(proof?.ok === true && Number.isSafeInteger(proof.checks) && proof.checks > 0 && proof.platform === process.platform,
    'The archived-chat safety test did not verify this operating system. No profiles were changed.');
  return { ok: true, checks: proof.checks, platform: proof.platform };
}

export function discoverCliPackageRoot({ explicit, executable, realpath = value => fs.realpathSync(value) } = {}) {
  if (explicit) { requireValue(path.isAbsolute(explicit), '--cli-package-root must be an absolute path.'); return path.resolve(explicit); }
  if (!executable) return null;
  let resolved;
  try { resolved = realpath(executable); } catch { return null; }
  // An npm-installed dsh executable resolves to this published package entry.
  const normalized = resolved.replaceAll('\\', '/');
  if (!normalized.endsWith('/@deepseek-ai/dsh/lib/bin.js')) return null;
  return path.dirname(path.dirname(path.dirname(resolved)));
}

export function discoverArchiveRoots(profiles, { appBundle, cliPackageRoot } = {}) {
  const roots = {}, skipped = [];
  for (const profile of profiles) {
    const name = profile.name;
    const packageRoot = name === 'desktop'
      ? (appBundle ? path.join(appBundle, 'Contents/Resources/app.asar/dsh/node_modules/@deepseek-ai') : null) : cliPackageRoot;
    if (packageRoot) roots[name] = packageRoot;
    else {
      requireValue(!hasArchivePlugin(fs.readFileSync(profile.filename, 'utf8')),
        `The ${name} profile already uses archived-chat deletion, but its Harness runtime cannot be verified. Set --cli-package-root or select the correct app bundle before upgrading.`);
      skipped.push(`${name}: no verifiable ${name === 'desktop' ? 'desktop app or CLI' : 'CLI'} runtime; archive registration left unchanged.`);
    }
  }
  requireValue(Object.keys(roots).length > 0, 'No installed Harness runtime could be verified for archived-chat deletion. Install/open Harness first or supply --cli-package-root.');
  return { roots, skipped };
}

export function configureProfile(source, { host: rawHost, pluginPath, nativeBundle }) {
  const host = validateHost(rawHost);
  const doc = YAML.parseDocument(source || '[]\n', options);
  requireValue(doc.errors.length === 0, 'Harness profile contains invalid YAML.');
  const before = doc.toJS();
  requireValue(Array.isArray(before), 'Harness profiles must contain a patch list.');
  const expected = structuredClone(before);
  const provider = { displayName: `${host.label} (${new URL(host.url).host})`, api: 'openai-completions',
    baseURL: `${host.url}/v1`, apiKeyEnv: host.credentialRef,
    headers: { 'x-local-model-gateway-id': host.gatewayId }, models: structuredClone(MODELS) };
  const llm = before.flatMap((row, i) => row.id === 'llm-pi-ai' ? [i] : []);
  requireValue(llm.length <= 1, 'Multiple provider patches require manual review.');
  if (llm.length) {
    const i = llm[0];
    const existing = before[i].config?.providers?.[host.provider];
    if (existing) requireValue(existing.apiKeyEnv === host.credentialRef &&
      existing.headers?.['x-local-model-gateway-id'] === host.gatewayId &&
      existing.models?.length === MODEL_IDS.length && existing.models.every(model => MODEL_IDS.includes(model.id)),
    'This host provider already belongs to another configuration.');
    expected[i].config ??= {};
    expected[i].config.providers ??= {};
    expected[i].config.providers[host.provider] = provider;
    doc.setIn([i, 'config', 'providers', host.provider], provider);
  } else {
    const row = { id: 'llm-pi-ai', config: { providers: { [host.provider]: provider } } };
    expected.push(row); doc.add(row);
  }
  const plugin = nativeBundle
    ? { id: nativeBundle.loaderId, name: pluginId, disabled: false, config: {} }
    : { id: pluginId, name: pathToFileURL(path.join(pluginPath, 'index.mjs')).href, config: {} };
  if (nativeBundle) configureNativeRegistration(doc, before, expected, { nativeBundle, id: pluginId, ids: modelPluginIds,
    pluginPath, legacyPath: 'local-model-switch-client', plugin, configKeys: [] });
  else {
    requireValue(!before.some(row => modelPluginIds.has(row.id) || row.id === `${pluginId}-bundle`), 'Unexpected direct override for the Windows switch plugin.');
    const found = [];
    for (const [i, row] of before.entries()) for (const [j, item] of (row.insert || []).entries()) if (modelPluginIds.has(item.id)) found.push([i, j]);
    requireValue(found.length <= 1, 'Duplicate Windows switch plugins require manual review.');
    if (found.length) {
      const [i, j] = found[0];
      const existing = before[i].insert[j];
      const knownLegacy = existing.id !== pluginId && existing.name ===
        pathToFileURL(path.join(path.dirname(pluginPath), 'local-model-switch-client', 'index.mjs')).href;
      requireValue((existing.name === plugin.name || knownLegacy) && Object.keys(existing.config || {}).length === 0,
        'The Windows switch plugin points to an unexpected location or configuration.');
      expected[i].insert[j] = plugin; doc.setIn([i, 'insert', j], plugin);
    } else { expected.push({ insert: [plugin] }); doc.add({ insert: [plugin] }); }
  }
  const output = String(doc);
  requireValue(JSON.stringify(YAML.parse(output, options)) === JSON.stringify(expected), 'Unexpected profile rewrite.');
  requireValue((output.match(/!!js\b/g) || []).length === (source.match(/!!js\b/g) || []).length, 'JavaScript configuration tags changed.');
  return { output, changed: JSON.stringify(before) !== JSON.stringify(expected) };
}

export function configureCredentials(source, key, credentialRef) {
  requireValue(/^DSH_SWITCH_[A-Z0-9_]+_KEY$/.test(credentialRef), 'The credential reference is invalid.');
  requireValue(typeof key === 'string' && key.trim().length > 0 && !/[\r\n\x00]/.test(key), 'The API key is invalid.');
  const doc = YAML.parseDocument(source || 'version: 1\nrefs: {}\n');
  requireValue(doc.errors.length === 0, 'The Harness credential store contains invalid YAML.');
  const before = doc.toJS();
  requireValue(before && before.version === 1 && !Array.isArray(before), 'Unsupported Harness credential store format; this installer supports version 1.');
  requireValue(before.refs === undefined || (before.refs && typeof before.refs === 'object' && !Array.isArray(before.refs)), 'Invalid credential reference map.');
  const expected = structuredClone(before); expected.refs ??= {}; expected.refs[credentialRef] = key;
  doc.setIn(['refs', credentialRef], key);
  const output = String(doc);
  requireValue(JSON.stringify(YAML.parse(output)) === JSON.stringify(expected), 'Unexpected credential store rewrite.');
  return { output, changed: before.refs?.[credentialRef] !== key };
}

export async function preflight(gatewayURL, key, fetcher = fetch, expectedGatewayId) {
  let response;
  try { response = await fetcher(`${validateGatewayURL(gatewayURL)}/local-switch/models`, {
    headers: { Authorization: `Bearer ${key}`, ...(expectedGatewayId ? { 'x-local-model-gateway-id': expectedGatewayId } : {}) }, signal: AbortSignal.timeout(10000), redirect: 'error',
  }); } catch { throw new Error('Cannot reach the Windows gateway. Confirm the PC is awake, gateway v2 is running, and its LAN firewall step has been completed.'); }
  requireValue(response.ok, response.status === 401 || response.status === 403 ? 'The Windows server rejected the key or this network client.' : 'The Windows gateway did not return its model catalog.');
  let data;
  try { data = await response.json(); } catch { throw new Error('The Windows gateway returned invalid catalog data.'); }
  requireValue(data.gateway === 'local-model-switch' && data.version === 2 && Array.isArray(data.models), 'This client needs the Windows model switch gateway version 2.');
  requireValue(typeof data.gatewayId === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(data.gatewayId), 'The server has no stable gateway identity.');
  requireValue(!expectedGatewayId || data.gatewayId === expectedGatewayId, 'The server identity changed. No Mac settings were changed. Review the server address and saved host.');
  for (const model of MODELS) {
    const matches = data.models.filter(item => item.id === model.id);
    requireValue(matches.length === 1 && matches[0].contextWindow === model.contextWindow && matches[0].maxTokens === model.maxTokens,
      'The Windows catalog does not match the four configured models. No Mac settings were changed.');
  }
  return data;
}

function prompt(label, { hidden = false } = {}) {
  requireValue(process.stdin.isTTY, 'Interactive input is required. Run Install.command from Terminal; never put the key in command arguments.');
  return new Promise((resolve, reject) => {
    let muted = false;
    const output = new Writable({ write(chunk, encoding, callback) { if (!muted) process.stdout.write(chunk); callback(); } });
    const rl = readline.createInterface({ input: process.stdin, output, terminal: true });
    process.stdout.write(label); muted = hidden;
    rl.question('', answer => { muted = false; rl.close(); if (hidden) process.stdout.write('\n'); resolve(answer.trim()); });
    rl.once('SIGINT', () => { muted = false; rl.close(); process.stdout.write('\n'); reject(new Error('Installation canceled.')); });
  });
}

export function harnessProcessesRunning(output, { pid = process.pid, appBundle, appBundles = [], cliPackageRoot, userHome = os.homedir() } = {}) {
  const bundles = new Set(['/Applications/DeepSeek Harness.app', path.join(userHome, 'Applications/DeepSeek Harness.app'),
    ...appBundles.map(value => path.resolve(value)), ...(appBundle ? [path.resolve(appBundle)] : [])]);
  const cliEntry = cliPackageRoot ? path.join(cliPackageRoot, 'dsh/lib/bin.js') : null;
  return output.split('\n').some(line => {
    const match = line.trim().match(/^(\d+)\s+(.+)$/);
    if (!match || Number(match[1]) === pid) return false;
    const command = match[2];
    return [...bundles].some(bundle => ['MacOS', 'Frameworks'].some(part => command.includes(path.join(bundle, 'Contents', part) + path.sep))) ||
      Boolean(cliEntry && command.includes(cliEntry)) ||
      /DeepSeek Harness\.app\/Contents\/(MacOS\/|Frameworks\/)/.test(command) ||
      /(?:@deepseek-ai\/dsh\/lib\/bin\.js|\bdsh (?:web|run|start|plugin)\b)/.test(command);
  });
}

function assertHarnessClosed(context = {}) {
  const output = execFileSync('/bin/ps', ['-axo', 'pid=,command='], { encoding: 'utf8' });
  requireValue(!harnessProcessesRunning(output, context), 'Quit DeepSeek Harness completely with its Quit menu (Command-Q), and stop any dsh web/headless session or other installer, then run the installer again.');
}

function assertNativeContract(bundle = process.env.DSH_INSTALL_APP_BUNDLE) {
  if (!bundle) return { verified: false, note: 'Native package API checks were unavailable; use the supported Harness release described in README.' };
  const modules = path.join(bundle, 'Contents/Resources/app.asar/dsh/node_modules/@deepseek-ai');
  try {
    const connection = fs.readFileSync(path.join(modules, 'dsh-client-connection/lib/index.js'), 'utf8');
    const conversation = fs.readFileSync(path.join(modules, 'dsh-client-ui-conversation/lib/client.js'), 'utf8');
    requireValue(connection.includes('registerFetchRoute') && conversation.includes('conversation.input.dock') && conversation.includes('ComposerBlockRegistry'), 'The installed Harness does not expose the plugin APIs this client needs.');
    return { verified: true };
  } catch (error) {
    if (error.code === 'ENOTDIR' || error.code === 'ENOENT') return { verified: false, note: 'Could not inspect bundled app modules; macOS compatibility will need a live check.' };
    throw error;
  }
}

function noSymlinkParents(filename, boundary) {
  const relative = path.relative(boundary, filename);
  requireValue(relative && !relative.startsWith('..') && !path.isAbsolute(relative), 'The install target escaped the Harness home.');
  let current = boundary;
  if (fs.existsSync(current)) requireValue(!fs.lstatSync(current).isSymbolicLink(), 'Refusing to modify a symlinked Harness home.');
  for (const part of relative.split(path.sep)) {
    current = path.join(current, part);
    if (fs.existsSync(current)) requireValue(!fs.lstatSync(current).isSymbolicLink(), 'Refusing to modify an install target through a symbolic link.');
  }
}

function atomicWrite(filename, content, mode = 0o600) {
  fs.mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 });
  const temporary = `${filename}.${randomUUID()}.tmp`;
  try { fs.writeFileSync(temporary, content, { mode }); fs.renameSync(temporary, filename); fs.chmodSync(filename, mode); }
  finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
}

export function applyTransaction(changes, { home, backupRoot, closedCheck = assertHarnessClosed, metadata = {} }) {
  closedCheck();
  for (const item of changes) noSymlinkParents(item.filename, home);
  noSymlinkParents(path.join(backupRoot, 'manifest.json'), home);
  fs.mkdirSync(backupRoot, { recursive: true, mode: 0o700 }); fs.chmodSync(backupRoot, 0o700);
  const manifest = changes.map((item, i) => {
    const prior = fs.existsSync(item.filename) ? fs.readFileSync(item.filename) : null;
    if (prior) fs.writeFileSync(path.join(backupRoot, `${i}.before`), prior, { mode: 0o600 });
    return { filename: item.filename, existed: prior !== null, before: `${i}.before`, beforeHash: prior ? sha(prior) : null,
      beforeMode: prior ? fs.statSync(item.filename).mode & 0o777 : null, afterHash: sha(item.content), mode: item.mode ?? 0o600 };
  });
  fs.writeFileSync(path.join(backupRoot, 'manifest.json'), JSON.stringify({ version: 1, home, metadata, files: manifest }, null, 2), { mode: 0o600 });
  const written = [];
  try {
    for (const [i, item] of changes.entries()) {
      closedCheck();
      const row = manifest[i];
      const current = fs.existsSync(item.filename) ? fs.readFileSync(item.filename) : null;
      requireValue((current ? sha(current) : null) === row.beforeHash, 'A Harness file changed during installation. Retry after closing all Harness processes.');
      atomicWrite(item.filename, item.content, item.mode); written.push(row);
    }
  } catch (error) {
    for (const row of written.reverse()) {
      if (row.existed) atomicWrite(row.filename, fs.readFileSync(path.join(backupRoot, row.before)), row.beforeMode ?? row.mode);
      else if (fs.existsSync(row.filename)) fs.unlinkSync(row.filename);
    }
    throw error;
  }
  return manifest;
}

export function rollback(backupRoot, { closedCheck = assertHarnessClosed, home = path.resolve(process.env.DSH_HOME || path.join(os.homedir(), '.dsh')) } = {}) {
  closedCheck();
  const backupBoundary = path.join(home, 'backups');
  requireValue(path.resolve(backupRoot).startsWith(backupBoundary + path.sep), 'Rollback backups must be inside this Harness home.');
  noSymlinkParents(path.join(backupRoot, 'manifest.json'), home);
  const manifest = JSON.parse(fs.readFileSync(path.join(backupRoot, 'manifest.json'), 'utf8'));
  requireValue(manifest.version === 1 && manifest.home === home && Array.isArray(manifest.files), 'Invalid rollback manifest.');
  requireValue(installerDistribution.id === 'dsh-plugins' || manifest.metadata?.distribution === installerDistribution.id,
    'This backup belongs to another installer. Use the installer that created that transaction.');
  const runtimeContext = manifest.metadata && typeof manifest.metadata === 'object' && !Array.isArray(manifest.metadata) ? manifest.metadata : {};
  closedCheck(runtimeContext);
  const targets = new Set();
  for (const row of manifest.files) {
    requireValue(typeof row.filename === 'string' && path.isAbsolute(row.filename) && !targets.has(path.resolve(row.filename)), 'Invalid or duplicate rollback target.');
    targets.add(path.resolve(row.filename));
    requireValue(typeof row.existed === 'boolean' && typeof row.before === 'string' && /^\d+\.before$/.test(row.before) &&
      /^[a-f0-9]{64}$/.test(row.afterHash) && (!row.existed || /^[a-f0-9]{64}$/.test(row.beforeHash)), 'Invalid rollback backup record.');
    for (const mode of [row.mode, row.beforeMode ?? row.mode]) requireValue(Number.isSafeInteger(mode) && mode >= 0 && mode <= 0o777, 'Invalid rollback permissions.');
    noSymlinkParents(row.filename, manifest.home);
    requireValue(fs.existsSync(row.filename) && sha(fs.readFileSync(row.filename)) === row.afterHash,
      'A file has changed since installation. Rollback stopped to preserve newer settings; review the private backup instead.');
    if (row.existed) {
      noSymlinkParents(path.join(backupRoot, row.before), home);
      requireValue(sha(fs.readFileSync(path.join(backupRoot, row.before))) === row.beforeHash, 'A rollback backup is damaged.');
    }
  }
  for (const row of [...manifest.files].reverse()) {
    closedCheck(runtimeContext);
    if (row.existed) atomicWrite(row.filename, fs.readFileSync(path.join(backupRoot, row.before)), row.beforeMode ?? row.mode);
    else fs.unlinkSync(row.filename);
  }
}

/** Standalone uninstall never falls back to another plugin's or the suite's receipt. */
export function lastInstallMarker(home) {
  if (installerDistribution.id === 'dsh-plugins' && !fs.existsSync(path.join(home, installerDistribution.receiptName))) {
    return path.join(home, 'local-model-switch-last-install.json');
  }
  return path.join(home, installerDistribution.receiptName);
}

export function parseArguments(args) {
  const values = new Set(['--plugins', '--server', '--gateway', '--host-id', '--host-label', '--cli-package-root', '--app-bundle']);
  const flags = new Set(['--apply', '--check', '--ask-key', '--help']);
  const result = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    requireValue(!Object.hasOwn(result, arg), 'Duplicate installer option.');
    if (flags.has(arg)) result[arg] = true;
    else if (values.has(arg)) {
      requireValue(typeof args[i + 1] === 'string' && !args[i + 1].startsWith('--'), 'An installer option is missing its value.');
      result[arg] = args[++i];
    } else if (arg === '--rollback') {
      result[arg] = args[i + 1] && !args[i + 1].startsWith('--') ? args[++i] : true;
    } else throw new Error('Unknown installer option. Use --help. API keys must not be command arguments.');
  }
  requireValue(!(result['--apply'] && result['--check']), 'Choose --apply or --check.');
  requireValue(!result['--rollback'] || Object.keys(result).length === 1, '--rollback cannot be combined with installation options.');
  const selected = pluginSelection(result['--plugins']);
  requireValue(selected.modelSwitch || !['--server', '--gateway', '--host-id', '--host-label', '--ask-key'].some(key => Object.hasOwn(result, key)),
    'Archive-only installation does not use a model server or API key. Remove the model-host options.');
  return result;
}

/** Plan entirely in memory; archive-only mode never reads model config or credentials. */
export function buildInstallPlan({ home, profiles, selected = pluginSelection(), host, key, archiveRoots = {}, sourceRoot = import.meta.dirname }) {
  const permitted = pluginSelection(selected.name);
  requireValue(selected.modelSwitch === permitted.modelSwitch && selected.archiveDelete === permitted.archiveDelete,
    'Invalid plugin selection.');
  profiles = selectInstallProfiles(profiles, { sourceRoot });
  const modelPath = path.join(home, 'plugins', pluginId);
  const archivePath = path.join(home, 'plugins', archiveId);
  const changes = [];
  let copyModelRuntime = false, copyArchiveRuntime = false;
  const add = (filename, content, mode = 0o600) => {
    const bytes = Buffer.isBuffer(content) ? content : Buffer.from(content);
    if (!fs.existsSync(filename) || !bytes.equals(fs.readFileSync(filename)) ||
        (process.platform !== 'win32' && mode === 0o600 && (fs.statSync(filename).mode & 0o077) !== 0)) changes.push({ filename, content, mode });
  };
  for (const { name, filename } of profiles) {
    const original = fs.readFileSync(filename, 'utf8');
    let output = original, changed = false;
    if (selected.modelSwitch) {
      const nativeBundle = discoverNativeBundle({ name, filename }, pluginId, { sourceRoot });
      const result = configureProfile(output, { host, pluginPath: modelPath, nativeBundle });
      copyModelRuntime ||= !nativeBundle;
      output = result.output; changed ||= result.changed;
    }
    if (selected.archiveDelete && archiveRoots[name]) {
      const nativeBundle = discoverNativeBundle({ name, filename }, archiveId, { sourceRoot });
      const result = configureArchiveProfile(output, { pluginPath: archivePath, packageRoot: archiveRoots[name], nativeBundle });
      copyArchiveRuntime ||= !nativeBundle;
      output = result.output; changed ||= result.changed;
    }
    if (changed) add(filename, output);
  }
  if (selected.modelSwitch) {
    const configFile = path.join(home, 'local-model-switch-client.json');
    const existing = fs.existsSync(configFile) ? validateClientConfig(JSON.parse(fs.readFileSync(configFile, 'utf8'))) : { version: 2, hosts: [] };
    const next = validateClientConfig({ version: 2, hosts: [...existing.hosts.filter(item => item.id !== host.id), host] });
    add(configFile, JSON.stringify(next, null, 2) + '\n');
    const credentialsFile = path.join(home, '.credentials.yaml');
    const credentials = configureCredentials(fs.existsSync(credentialsFile) ? fs.readFileSync(credentialsFile, 'utf8') : '', key, host.credentialRef);
    add(credentialsFile, credentials.output);
    if (copyModelRuntime) for (const name of runtimeFiles) add(path.join(modelPath, name), fs.readFileSync(sourceFile(pluginId, name, sourceRoot)), 0o644);
  }
  if (selected.archiveDelete) {
    requireValue(Object.keys(archiveRoots).length > 0, 'No archive profile runtime was verified.');
    if (copyArchiveRuntime) for (const name of archiveRuntimeFiles) add(path.join(archivePath, name), fs.readFileSync(sourceFile(archiveId, name, sourceRoot)), 0o644);
  }
  return changes;
}

async function main() {
  const args = parseArguments(process.argv.slice(2));
  if (args['--help']) {
    const selectionHelp = installerDistribution.id === 'dsh-plugins' ? 'both | model-switch | archive-delete' : installerDistribution.defaultSelection;
    console.log(`${installerDistribution.id} for macOS\n\nInstall.command [--apply | --check] [--plugins ${selectionHelp}]\n  --server URL --host-id ID --host-label LABEL --ask-key\n  --app-bundle PATH --cli-package-root PATH\n  --rollback [BACKUP_DIRECTORY]\n\nDefault: ${installerDistribution.defaultSelection}. Archive-only needs no model-host connection or key. Keys are entered at a hidden prompt. --check runs synthetic safety tests without changing user profiles or chats.`);
    return;
  }
  requireValue(Number(process.versions.node.split('.')[0]) >= 22, 'Node.js 22 or newer is required.');
  requireValue(process.platform === 'darwin', 'This installer is for macOS. It does not install a server on Windows.');
  const home = path.resolve(process.env.DSH_HOME || path.join(os.homedir(), '.dsh'));
  const appBundle = args['--app-bundle'] || process.env.DSH_INSTALL_APP_BUNDLE;
  requireValue(!appBundle || path.isAbsolute(appBundle), '--app-bundle must be an absolute app path.');
  let executable;
  try { executable = execFileSync('/bin/sh', ['-c', 'command -v dsh'], { encoding: 'utf8' }).trim(); } catch {}
  const cliPackageRoot = discoverCliPackageRoot({ explicit: args['--cli-package-root'] || process.env.DSH_CLI_PACKAGE_ROOT, executable });
  const closedCheck = () => assertHarnessClosed({ appBundle, cliPackageRoot });
  if (args['--rollback']) {
    const receipt = typeof args['--rollback'] === 'string' ? {} : JSON.parse(fs.readFileSync(lastInstallMarker(home), 'utf8'));
    const backup = typeof args['--rollback'] === 'string' ? args['--rollback'] : receipt.backup;
    rollback(backup, { home, closedCheck: (metadata = {}) => assertHarnessClosed({ appBundle,
      cliPackageRoot: typeof metadata.cliPackageRoot === 'string' ? metadata.cliPackageRoot : receipt.cliPackageRoot || cliPackageRoot,
      appBundles: [metadata.appBundle, receipt.appBundle].filter(value => typeof value === 'string') }) });
    console.log('Previous Harness files restored. Restart Harness normally.'); return;
  }
  const selected = pluginSelection(args['--plugins']);
  const profiles = selectInstallProfiles(['desktop', 'web', 'headless'].map(name => ({ name, filename: path.join(home, 'profiles', name, 'cordis.patch.yml') })).filter(row => fs.existsSync(row.filename)));
  requireValue(profiles.length > 0, 'Open DeepSeek Harness once and quit it before installing. No existing profile was found.');
  // Native filesystem validation also requires the real Harness processes to be stopped.
  if (args['--apply'] || selected.archiveDelete) closedCheck();
  let host, key;
  if (selected.modelSwitch) {
    const configFile = path.join(home, 'local-model-switch-client.json');
    const existingConfig = fs.existsSync(configFile) ? validateClientConfig(JSON.parse(fs.readFileSync(configFile, 'utf8'))) : { version: 2, hosts: [] };
    const hostId = args['--host-id'] || 'pc';
    requireValue(/^[a-z][a-z0-9-]{0,23}$/.test(hostId), 'Use a short host ID: lowercase letters, digits and hyphens, beginning with a letter.');
    const savedHost = existingConfig.hosts.find(item => item.id === hostId);
    const defaultURL = savedHost?.url;
    const enteredURL = args['--server'] || args['--gateway'] || await prompt(`Model server URL for ${hostId}${defaultURL ? ` [${defaultURL}]` : ' (for example http://your-pc.local:8083)'}: `);
    requireValue(Boolean(enteredURL || defaultURL), 'Enter the address of your compatible model gateway. No server address is bundled with this installer.');
    const gatewayURL = validateGatewayURL(enteredURL || defaultURL);
    const credentialRef = hostCredentialRef(hostId);
    const credentialsFile = path.join(home, '.credentials.yaml');
    const credentialDocument = YAML.parseDocument(fs.existsSync(credentialsFile) ? fs.readFileSync(credentialsFile, 'utf8') : 'version: 1\nrefs: {}\n');
    requireValue(credentialDocument.errors.length === 0, 'The Harness credential store contains invalid YAML.');
    const credentialData = credentialDocument.toJS();
    requireValue(credentialData?.version === 1, 'Unsupported Harness credential store format; this installer supports version 1.');
    key = (!args['--ask-key'] && (credentialData.refs?.[credentialRef] || process.env[credentialRef])) || await prompt('Model gateway API key (hidden): ', { hidden: true });
    const catalog = await preflight(gatewayURL, key, fetch, savedHost?.gatewayId);
    const defaultLabel = savedHost?.label || catalog.hostLabel || 'Model host';
    const label = args['--host-label'] || await prompt(`Host label [${defaultLabel}]: `) || defaultLabel;
    host = validateHost({ id: hostId, label, url: gatewayURL, provider: hostProvider(hostId), credentialRef, gatewayId: catalog.gatewayId });
  }
  let archiveRoots = {}, skipped = [], archiveProofs = [];
  if (selected.archiveDelete) {
    ({ roots: archiveRoots, skipped } = discoverArchiveRoots(profiles, { appBundle, cliPackageRoot }));
    for (const packageRoot of new Set(Object.values(archiveRoots))) {
      closedCheck();
      const packages = verifyArchivePackages(packageRoot);
      const smokeTest = runArchiveSmokeTest(packageRoot);
      archiveProofs.push({ ...packages, smokeTest });
    }
  }
  const contract = selected.modelSwitch ? assertNativeContract(appBundle) : { verified: true };
  const changes = buildInstallPlan({ home, profiles, selected, host, key, archiveRoots });
  console.log(`Selected ${selected.name}; ${profiles.length} existing profile(s); ${changes.length} file change(s).`);
  if (host) console.log(`Verified ${host.label} at ${host.url}; four remote models. Installation does not load a model.`);
  for (const note of skipped) console.log(note);
  if (archiveProofs.length) console.log('Archived-chat safety tests passed using temporary synthetic chats. Your chats were not changed.');
  if (!contract.verified) console.log(contract.note);
  if (!args['--apply']) { console.log('Check only: no user profiles or chats changed. Run with --apply to install.'); return; }
  if (changes.length === 0) { console.log('Already installed with these settings. Restart Harness if needed.'); return; }
  const backup = path.join(home, 'backups', `${installerDistribution.backupPrefix}-${new Date().toISOString().replace(/[:.]/g, '-')}`);
  const metadata = { distribution: installerDistribution.id, plugins: selected.name, appBundle, cliPackageRoot, archiveProfiles: Object.keys(archiveRoots), archiveProofs, skippedProfiles: skipped, installedAt: new Date().toISOString() };
  changes.push({ filename: path.join(home, installerDistribution.receiptName), content: JSON.stringify({ backup, ...metadata }, null, 2) + '\n' });
  applyTransaction(changes, { home, backupRoot: backup, metadata, closedCheck });
  console.log('Installed. Open Harness normally. Existing providers, defaults, and chats were preserved.');
  if (host) console.log(`Choose a remote model under ${host.label}; all clients of that host share its loaded model.`);
  if (selected.archiveDelete) console.log('In Archived, use the trash button or Delete archived chat menu item. Confirmation is required; a local recovery backup remains.');
  console.log(`Private rollback backup: ${backup}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => { console.error(`Installation stopped: ${error.message}`); process.exitCode = 1; });
}
