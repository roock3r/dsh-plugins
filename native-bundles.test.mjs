import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import YAML from './vendor/yaml/dist/index.js';
import { configureArchiveProfile, configureProfile, discoverNativeBundle } from './install.mjs';
import { hostCredentialRef, hostProvider } from './plugins/dsh-model-switcher/catalog.mjs';

const names = ['dsh-model-switcher', 'dsh-delete-chat'];
const sourceRoot = name => path.join(import.meta.dirname, 'plugins', name);
const readJson = filename => JSON.parse(fs.readFileSync(filename, 'utf8'));

for (const name of names) {
  test(`${name}: native bundle starts dormant and manual enable requires setup`, async () => {
    const directory = sourceRoot(name);
    const manifest = readJson(path.join(directory, 'package.json'));
    assert.equal(manifest.name, name);
    assert.deepEqual(manifest.dsh.bundle, { patch: './cordis.patch.yml' });
    assert.equal(manifest.exports['./cordis.patch.yml'], './cordis.patch.yml');
    const patch = YAML.parse(fs.readFileSync(path.join(directory, manifest.dsh.bundle.patch), 'utf8'));
    assert.deepEqual(patch, [{ insert: [{
      id: `${name}-bundle`, name, disabled: true, config: { setupRequired: true },
    }] }]);
    const backend = await import(pathToFileURL(path.join(directory, 'index.mjs')).href);
    const untouched = new Proxy({}, { get() { throw new Error('Setup gate accessed the runtime.'); } });
    assert.throws(() => backend.apply(untouched, patch[0].insert[0].config), /needs one-time setup/);
  });
}

test('actual Harness discovers native bundles and composes migration without duplicate active entries', {
  skip: !process.env.DSH_DELETE_TEST_PACKAGE_ROOT,
}, async t => {
  const packageRoot = process.env.DSH_DELETE_TEST_PACKAGE_ROOT;
  const load = file => import(pathToFileURL(path.join(packageRoot, file)).href);
  const { composeEntries, loadOverlayPatches, bundlePatchPaths } = await load('dsh-app-boot/lib/index.js');
  const { bundleManifest } = await load('dsh-plugin-manager/lib/types/operations.js');
  const { parseInstallSpec } = await load('dsh-plugin-manager/lib/types/install-spec.js');
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-native-bundles-'));
  const temporaryParent = fs.realpathSync(os.tmpdir());
  t.after(() => {
    const resolved = fs.realpathSync(temporary);
    assert.equal(path.dirname(resolved), temporaryParent);
    assert.match(path.basename(resolved), /^dsh-native-bundles-/);
    fs.rmSync(resolved, { recursive: true, force: true });
  });
  const profile = path.join(temporary, 'profiles', 'test');
  fs.mkdirSync(profile, { recursive: true });
  fs.writeFileSync(path.join(profile, 'package.json'), JSON.stringify({
    dependencies: Object.fromEntries(names.map(name => [name, `github:roock3r/${name}`])),
    dsh: { profile: { bundles: names } },
  }));
  const anchor = path.join(packageRoot, 'dsh', 'package.json');
  for (const name of names) {
    const directory = path.join(profile, 'node_modules', name);
    fs.cpSync(sourceRoot(name), directory, { recursive: true });
    const manifest = bundleManifest(name, profile, anchor);
    assert.equal(manifest.name, name);
    const bundle = bundlePatchPaths(directory, manifest.dsh.bundle)
      .flatMap(file => loadOverlayPatches('dsh', file));
    assert.deepEqual(parseInstallSpec(`github:roock3r/${name}`), {
      kind: 'git', spec: `github:roock3r/${name}`, host: 'github.com',
    });
    assert.deepEqual(parseInstallSpec(`https://github.com/roock3r/${name}`), {
      kind: 'git', spec: `https://github.com/roock3r/${name}`, host: 'github.com',
    });
    const pluginPath = path.join(temporary, 'home', 'plugins', name);
    const previous = { id: name, name: pathToFileURL(path.join(pluginPath, 'index.mjs')).href };
    const beforeSetup = composeEntries([bundle, [{ insert: [previous] }]]);
    assert.equal(new Set(beforeSetup.map(row => row.id)).size, beforeSetup.length);
    assert.deepEqual(beforeSetup.filter(row => row.disabled !== true), [previous]);
    // Use the real installer migration, then compose its output in Harness.
    const config = name === 'dsh-delete-chat' ? { packageRoot } : {};
    const nativeBundle = discoverNativeBundle({ name: 'test', filename: path.join(profile, 'cordis.patch.yml') }, name);
    const host = { id: 'test', label: 'Test host', url: 'https://model-host.invalid',
      provider: hostProvider('test'), credentialRef: hostCredentialRef('test'),
      gatewayId: '11111111-1111-4111-8111-111111111111' };
    const configure = source => name === 'dsh-delete-chat'
      ? configureArchiveProfile(source, { pluginPath, packageRoot, nativeBundle })
      : configureProfile(source, { pluginPath, host, nativeBundle });
    const result = configure(YAML.stringify([{ insert: [previous] }]));
    const afterSetup = composeEntries([bundle, YAML.parse(result.output)]);
    const activePlugin = afterSetup.filter(row => row.name === name && row.disabled !== true);
    assert.deepEqual(activePlugin, [{ id: `${name}-bundle`, name, disabled: false, config }]);
    assert.equal(afterSetup.some(row => row.id === name), false);
    assert.equal(configure(result.output).changed, false);
    assert.equal(Object.hasOwn(activePlugin[0].config, 'setupRequired'), false);
  }
});
