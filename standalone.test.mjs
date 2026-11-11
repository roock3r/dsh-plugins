import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { standaloneFiles, standalonePlugins } from './scripts/standalone.mjs';
import { makeZip } from './scripts/zip.mjs';
import { checkPublicContents } from './scripts/release-files.mjs';

for (const plugin of standalonePlugins) test(`${plugin} export is deterministic, isolated, and runnable without the canonical workspace`, () => {
  const first = standaloneFiles(plugin), second = standaloneFiles(plugin);
  assert.deepEqual(makeZip(first.entries, plugin), makeZip(second.entries, plugin));
  const other = plugin === 'dsh-delete-chat' ? 'dsh-model-switcher' : 'dsh-delete-chat';
  assert.equal([...first.entries.keys()].some(name => name.startsWith('plugins/') || name.includes(other)), false);
  assert.equal(first.entries.has(plugin === 'dsh-delete-chat' ? 'catalog.mjs' : 'service.mjs'), false);
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-standalone-test-'));
  try {
    for (const [name, bytes] of first.entries) {
      const destination = path.join(temporary, name);
      fs.mkdirSync(path.dirname(destination), { recursive: true }); fs.writeFileSync(destination, bytes);
    }
    const result = spawnSync(process.execPath, ['--test', 'distribution.test.mjs'], { cwd: temporary,
      encoding: 'utf8', windowsHide: true, timeout: 30000 });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}\n${result.error?.message || ''}`);
  } finally {
    const resolved = fs.realpathSync(temporary), expectedParent = fs.realpathSync(os.tmpdir());
    assert.equal(path.dirname(resolved), expectedParent);
    assert.ok(path.basename(resolved).startsWith('dsh-standalone-test-'));
    fs.rmSync(resolved, { recursive: true });
  }
});

test('export validation rejects private artifact names and unsafe archive paths', () => {
  assert.throws(() => checkPublicContents(new Map([['.credentials.yaml', Buffer.from('fixture')]])), /Private artifact/);
  assert.throws(() => makeZip(new Map([['../escape', Buffer.from('fixture')]]), 'example'), /Unsafe ZIP path/);
  assert.throws(() => standaloneFiles('unknown'), /Unknown standalone/);
});
