/** Shared portable checks copied into each standalone distribution. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import YAML from './vendor/yaml/dist/index.js';

const read = name => fs.readFileSync(new URL(name, import.meta.url), 'utf8');
const metadata = JSON.parse(read('package.json'));

test('standalone installer restricts selection to this plugin and loads without the other runtime', async () => {
  const installer = await import('./install.mjs');
  const selected = installer.pluginSelection();
  assert.equal(selected.archiveDelete, metadata.name === 'dsh-delete-chat');
  assert.equal(selected.modelSwitch, metadata.name === 'dsh-model-switcher');
  assert.throws(() => installer.pluginSelection('both'));
  assert.throws(() => installer.pluginSelection(metadata.name === 'dsh-delete-chat' ? 'model-switch' : 'archive-delete'));
});

test('root package is discoverable and retains its notices and canonical provenance', async () => {
  const plugin = await import('./index.mjs');
  assert.equal(plugin.name, metadata.name);
  assert.equal(metadata.repository.url, `https://github.com/roock3r/${metadata.name}.git`);
  assert.equal(metadata.license, 'MIT');
  assert.match(read('LICENSE'), /Copyright \(c\) 2026 Cristian Silva/);
  assert.match(read('vendor/yaml/LICENSE'), /Permission to use, copy, modify, and\/or distribute/);
  const manifest = JSON.parse(read('SOURCE.json'));
  assert.equal(manifest.plugin, metadata.name);
  assert.equal(createHash('sha256').update(JSON.stringify(manifest.sources, null, 2) + '\n').digest('hex'), manifest.sourceTreeSha256);
});

test('GitHub bundle is dormant until one-time local setup and is documented with the correct URL', async () => {
  assert.deepEqual(metadata.dsh.bundle, { patch: './cordis.patch.yml' });
  assert.equal(metadata.exports['./cordis.patch.yml'], './cordis.patch.yml');
  const patch = YAML.parse(read('cordis.patch.yml'));
  assert.deepEqual(patch, [{ insert: [{ id: `${metadata.name}-bundle`, name: metadata.name,
    disabled: true, config: { setupRequired: true } }] }]);
  const backend = await import('./index.mjs');
  const untouched = new Proxy({}, { get() { throw new Error('Setup gate accessed runtime'); } });
  assert.throws(() => backend.apply(untouched, patch[0].insert[0].config), /needs one-time setup/);
  assert.ok(read('README.md').includes(`github:roock3r/${metadata.name}`));
  assert.ok(read('README.md').includes(`https://github.com/roock3r/${metadata.name}`));
  assert.ok(read('README.md').includes('Install.command'));
  assert.match(read('README.md'), /Live installation on the target Mac/);
});
