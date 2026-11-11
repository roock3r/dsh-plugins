import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import YAML from './vendor/yaml/dist/index.js';
import {
  pluginSelection, parseArguments, configureProfile, configureArchiveProfile, hasArchivePlugin,
  discoverCliPackageRoot, discoverArchiveRoots, verifyArchivePackages,
  runArchiveSmokeTest, buildInstallPlan, applyTransaction, rollback,
  harnessProcessesRunning,
  readInstallerDistribution, installerDistribution, lastInstallMarker,
  discoverNativeBundle, selectInstallProfiles,
} from './install.mjs';

const options = { customTags: [{ tag: 'tag:yaml.org,2002:js', resolve: value => value }] };
const profileSource = '# existing user comment\n- id: llm-pi-ai\n  config:\n    providers:\n      my-cloud: {apiKeyEnv: CLOUD_KEY, baseURL: https://example.test/v1}\n- id: agent-default-model\n  config: {provider: my-cloud, model: existing-model}\n- id: callback\n  config: {value: !!js custom.expression}\n';
const fixtureHost = { id: 'lab', label: 'Test model host', url: 'http://192.168.50.10:8083',
  provider: 'windows-lab', credentialRef: 'DSH_SWITCH_LAB_KEY', gatewayId: '11111111-1111-4111-8111-111111111111' };

function fixture(run) {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-suite-installer-test-'));
  const home = path.join(temporary, '.dsh'); fs.mkdirSync(home);
  const profiles = ['desktop', 'web', 'headless'].map(name => {
    const filename = path.join(home, 'profiles', name, 'cordis.patch.yml');
    fs.mkdirSync(path.dirname(filename), { recursive: true }); fs.writeFileSync(filename, profileSource);
    return { name, filename };
  });
  const sourceRoot = path.join(temporary, 'source'); fs.mkdirSync(sourceRoot);
  const fakeArchive = path.join(sourceRoot, 'plugins/dsh-delete-chat'); fs.mkdirSync(fakeArchive, { recursive: true });
  const fakeModel = path.join(sourceRoot, 'plugins/dsh-model-switcher'); fs.mkdirSync(fakeModel, { recursive: true });
  for (const name of ['package.json', 'LICENSE', 'index.mjs', 'client.js', 'catalog.mjs', 'settings.mjs', 'cordis.patch.yml']) fs.writeFileSync(path.join(fakeModel, name), `fixture ${name}`);
  for (const name of ['package.json', 'LICENSE', 'index.mjs', 'client.js', 'service.mjs', 'storage-adapter.mjs', 'posix-quarantine.mjs', 'cordis.patch.yml']) fs.writeFileSync(path.join(fakeArchive, name), `fixture archive ${name}`);
  try { return run({ temporary, home, profiles, sourceRoot, fakeArchive }); }
  finally {
    const resolved = path.resolve(temporary);
    assert.ok(resolved.startsWith(path.resolve(os.tmpdir()) + path.sep) && path.basename(resolved).startsWith('dsh-suite-installer-test-'));
    fs.rmSync(resolved, { recursive: true });
  }
}

test('both plugins are the default; archive-only has no model arguments', () => {
  assert.deepEqual(pluginSelection(), { name: 'both', modelSwitch: true, archiveDelete: true });
  assert.equal(pluginSelection('archive-delete').modelSwitch, false);
  assert.equal(pluginSelection('model-switch').archiveDelete, false);
  assert.throws(() => pluginSelection('everything'));
  assert.equal(parseArguments(['--apply', '--plugins', 'archive-delete'])['--plugins'], 'archive-delete');
  for (const args of [['--plugins'], ['--apply', '--check'], ['--key', 'fixture'], ['--rollback', '--apply'],
    ['--plugins', 'archive-delete', '--server', fixtureHost.url], ['--apply', '--apply']]) assert.throws(() => parseArguments(args));
});

test('distribution manifests permit only one canonical plugin at the repository root', () => fixture(({ sourceRoot }) => {
  assert.equal(readInstallerDistribution(sourceRoot).defaultSelection, 'both');
  const filename = path.join(sourceRoot, 'installer-distribution.json');
  for (const id of ['dsh-delete-chat', 'dsh-model-switcher']) {
    fs.writeFileSync(filename, JSON.stringify({ version: 1, plugins: { [id]: '.' } }));
    const distribution = readInstallerDistribution(sourceRoot);
    assert.equal(distribution.id, id); assert.deepEqual(distribution.roots, { [id]: '.' });
    assert.equal(distribution.receiptName, `${id}-last-install.json`);
    assert.equal(distribution.backupPrefix, id);
  }
  for (const manifest of [null, [], {}, { version: 2, plugins: { 'dsh-delete-chat': '.' } },
    { version: 1, plugins: { 'dsh-delete-chat': '.', 'dsh-model-switcher': '.' } },
    { version: 1, plugins: { unknown: '.' } }, { version: 1, plugins: { 'dsh-delete-chat': '../elsewhere' } },
    { version: 1, plugins: { 'dsh-delete-chat': '.' }, extra: true }]) {
    fs.writeFileSync(filename, JSON.stringify(manifest));
    assert.throws(() => readInstallerDistribution(sourceRoot), /manifest|exactly one/);
  }
  fs.writeFileSync(filename, 'invalid JSON');
  assert.throws(() => readInstallerDistribution(sourceRoot), /manifest/);
}));

test('suite rollback retains current and legacy receipt discovery', () => fixture(({ home }) => {
  assert.equal(installerDistribution.id, 'dsh-plugins');
  assert.equal(lastInstallMarker(home), path.join(home, 'local-model-switch-last-install.json'));
  fs.writeFileSync(path.join(home, 'companion-plugins-last-install.json'), '{}');
  assert.equal(lastInstallMarker(home), path.join(home, 'companion-plugins-last-install.json'));
}));

for (const id of ['dsh-delete-chat', 'dsh-model-switcher']) {
  test(`${id} standalone imports, plans, checks and rolls back without the other plugin`, () => fixture(({ temporary, home, profiles }) => {
    const sourceRoot = path.join(temporary, 'standalone');
    fs.cpSync(path.join(import.meta.dirname, 'plugins', id), sourceRoot, { recursive: true });
    fs.cpSync(path.join(import.meta.dirname, 'vendor'), path.join(sourceRoot, 'vendor'), { recursive: true });
    fs.copyFileSync(path.join(import.meta.dirname, 'install.mjs'), path.join(sourceRoot, 'install.mjs'));
    fs.writeFileSync(path.join(sourceRoot, 'installer-distribution.json'), JSON.stringify({ version: 1, plugins: { [id]: '.' } }));
    fs.writeFileSync(path.join(home, 'companion-plugins-last-install.json'), '{"backup":"other-installer"}');
    const selectedName = id === 'dsh-delete-chat' ? 'archive-delete' : 'model-switch';
    const excludedName = selectedName === 'archive-delete' ? 'model-switch' : 'archive-delete';
    const excludedId = id === 'dsh-delete-chat' ? 'dsh-model-switcher' : 'dsh-delete-chat';
    assert.equal(fs.existsSync(path.join(sourceRoot, 'plugins')), false);
    const output = execFileSync(process.execPath, ['--input-type=module', '-e', `
      import assert from 'node:assert/strict';
      import fs from 'node:fs';
      import path from 'node:path';
      const installer = await import(${JSON.stringify(pathToFileURL(path.join(sourceRoot, 'install.mjs')).href)});
      const { home, profiles, host } = ${JSON.stringify({ home, profiles, host: fixtureHost })};
      assert.equal(installer.pluginSelection().name, ${JSON.stringify(selectedName)});
      assert.throws(() => installer.pluginSelection('both'), /only/);
      assert.throws(() => installer.parseArguments(['--plugins', ${JSON.stringify(excludedName)}]), /only/);
      assert.equal(installer.lastInstallMarker(home), path.join(home, ${JSON.stringify(`${id}-last-install.json`)}));
      assert.throws(() => installer.buildInstallPlan({home, profiles, selected:{name:${JSON.stringify(selectedName)},modelSwitch:true,archiveDelete:true}}), /selection/);
      if (${JSON.stringify(id)} === 'dsh-delete-chat') {
        fs.writeFileSync(path.join(home, '.credentials.yaml'), 'intentionally malformed: [');
        fs.writeFileSync(path.join(home, 'local-model-switch-client.json'), 'malformed JSON');
        assert.throws(() => installer.parseArguments(['--server', host.url]), /does not use/);
        assert.throws(() => installer.verifyArchivePackages(path.join(home, 'unknown-packages')), /has not been verified/);
        let invoked;
        installer.runArchiveSmokeTest(home, {runner(runtime, args) {invoked=args[0]; return JSON.stringify({ok:true,checks:3,platform:process.platform});}});
        assert.equal(invoked, path.join(${JSON.stringify(sourceRoot)}, 'self-test.mjs'));
        assert.throws(() => installer.runArchiveSmokeTest(home, {runner(){return '{"ok":false}';}}), /safety test/);
      } else {
        const {MODELS} = await import(${JSON.stringify(pathToFileURL(path.join(sourceRoot, 'catalog.mjs')).href)});
        const catalog = {gateway:'local-model-switch',version:2,gatewayId:host.gatewayId,models:MODELS};
        await installer.preflight(host.url, 'fixture-key', async()=>({ok:true,json:async()=>catalog}), host.gatewayId);
        await assert.rejects(installer.preflight(host.url, 'fixture-key', async()=>({ok:true,json:async()=>({...catalog,gatewayId:'22222222-2222-4222-8222-222222222222'})}), host.gatewayId), /identity changed/);
      }
      const changes=installer.buildInstallPlan({home,profiles,host,key:'fixture-key',archiveRoots:{desktop:path.join(home,'verified-packages')}});
      assert.ok(changes.some(row=>row.filename===path.join(home,'plugins',${JSON.stringify(id)},'index.mjs')));
      assert.ok(changes.every(row=>!row.filename.includes(${JSON.stringify(excludedId)})));
      if (${JSON.stringify(id)} === 'dsh-delete-chat') assert.ok(changes.every(row=>!row.filename.endsWith('.credentials.yaml')&&!row.filename.endsWith('local-model-switch-client.json')));
      const before=profiles.map(row=>fs.readFileSync(row.filename,'utf8'));
      const backupRoot=path.join(home,'backups',installer.installerDistribution.backupPrefix+'-fixture');
      installer.applyTransaction(changes,{home,backupRoot,closedCheck(){},metadata:{distribution:${JSON.stringify(id)}}});
      const manifestPath=path.join(backupRoot,'manifest.json');
      const manifest=fs.readFileSync(manifestPath,'utf8');
      const foreign=JSON.parse(manifest);foreign.metadata.distribution=${JSON.stringify(excludedId)};
      fs.writeFileSync(manifestPath,JSON.stringify(foreign));
      assert.throws(()=>installer.rollback(backupRoot,{home,closedCheck(){}}),/another installer/);
      assert.ok(fs.existsSync(path.join(home,'plugins',${JSON.stringify(id)},'index.mjs')));
      fs.writeFileSync(manifestPath,manifest);
      installer.rollback(backupRoot,{home,closedCheck(){}});
      profiles.forEach((row,i)=>assert.equal(fs.readFileSync(row.filename,'utf8'),before[i]));
      assert.equal(fs.existsSync(path.join(home,'plugins',${JSON.stringify(id)},'index.mjs')),false);
      const nativeProfile=profiles[0], nativeProfileDir=path.dirname(nativeProfile.filename);
      fs.cpSync(${JSON.stringify(sourceRoot)},path.join(nativeProfileDir,'node_modules',${JSON.stringify(id)}),{recursive:true});
      fs.writeFileSync(path.join(nativeProfileDir,'package.json'),JSON.stringify({dependencies:{[${JSON.stringify(id)}]:'github:example/plugin'},dsh:{profile:{bundles:[${JSON.stringify(id)}]}}}));
      fs.writeFileSync(profiles[1].filename,${JSON.stringify('# unrelated profile\nthis is deliberately not a patch list')});
      fs.writeFileSync(profiles[2].filename,${JSON.stringify('- id: archived-chat-delete\n')});
      const untouched=profiles.slice(1).map(row=>fs.readFileSync(row.filename,'utf8'));
      const scoped=installer.selectInstallProfiles(profiles);
      assert.deepEqual(scoped,[nativeProfile]);
      if (${JSON.stringify(id)} === 'dsh-delete-chat') {
        const discovery=installer.discoverArchiveRoots(scoped,{appBundle:path.join(home,'Harness.app')});
        assert.deepEqual(Object.keys(discovery.roots),['desktop']);
      }
      const nativePlan=installer.buildInstallPlan({home,profiles,host,key:'fixture-key',archiveRoots:{desktop:path.join(home,'verified-packages')}});
      assert.deepEqual(nativePlan.filter(row=>profiles.some(profile=>profile.filename===row.filename)).map(row=>row.filename),[nativeProfile.filename]);
      assert.ok(nativePlan.every(row=>!row.filename.startsWith(path.join(home,'plugins')+path.sep)));
      const nativeRows=nativePlan.find(row=>row.filename===nativeProfile.filename).content.toString();
      assert.ok(nativeRows.includes(${JSON.stringify(`${id}-bundle`)}));
      profiles.slice(1).forEach((row,i)=>assert.equal(fs.readFileSync(row.filename,'utf8'),untouched[i]));
      console.log('standalone verified');
    `], { encoding: 'utf8', timeout: 15000, windowsHide: true });
    assert.match(output, /standalone verified/);
    const help = execFileSync(process.execPath, [path.join(sourceRoot, 'install.mjs'), '--help'], { encoding: 'utf8', timeout: 15000, windowsHide: true });
    assert.match(help, new RegExp(`Default: ${selectedName}`));
  }));
}

test('archive registration preserves providers, defaults, comments and executable YAML tags', () => fixture(({ home }) => {
  const pluginPath = path.join(home, 'plugins/dsh-delete-chat'), packageRoot = path.join(home, 'fixture-packages');
  const result = configureArchiveProfile(profileSource, { pluginPath, packageRoot });
  const before = YAML.parse(profileSource, options), after = YAML.parse(result.output, options);
  assert.deepEqual(after.slice(0, before.length), before);
  assert.match(result.output, /# existing user comment/); assert.match(result.output, /!!js custom.expression/);
  assert.equal(after.at(-1).insert[0].config.packageRoot, packageRoot);
  assert.equal(hasArchivePlugin(result.output), true);
  assert.equal(configureArchiveProfile(result.output, { pluginPath, packageRoot }).changed, false);
  const revised = configureArchiveProfile(result.output, { pluginPath, packageRoot: path.join(home, 'updated-packages') });
  assert.equal(revised.changed, true);
}));

test('archive registration refuses unrelated plugin overrides and duplicate registrations', () => fixture(({ home }) => {
  const config = { pluginPath: path.join(home, 'plugins/dsh-delete-chat'), packageRoot: path.join(home, 'fixture-packages') };
  assert.throws(() => configureArchiveProfile('- id: dsh-delete-chat\n', config), /direct/);
  const registered = YAML.parse(configureArchiveProfile(profileSource, config).output, options);
  registered.push(registered.at(-1));
  assert.throws(() => configureArchiveProfile(YAML.stringify(registered), config), /Duplicate/);
  const altered = YAML.parse(configureArchiveProfile(profileSource, config).output, options);
  altered.at(-1).insert[0].config.extra = true;
  assert.throws(() => configureArchiveProfile(YAML.stringify(altered), config), /unexpected/);
}));

function legacyProfile(home, modelId = 'windows-model-switch-client') {
  const canonical = configureArchiveProfile(configureProfile(profileSource, {
    host: fixtureHost, pluginPath: path.join(home, 'plugins/dsh-model-switcher'),
  }).output, { pluginPath: path.join(home, 'plugins/dsh-delete-chat'), packageRoot: path.join(home, 'old-packages') }).output;
  const doc = YAML.parseDocument(canonical, options);
  const rows = doc.toJS();
  for (const [i, row] of rows.entries()) for (const [j, entry] of (row.insert || []).entries()) {
    if (entry.id === 'dsh-model-switcher') {
      doc.setIn([i, 'insert', j, 'id'], modelId);
      doc.setIn([i, 'insert', j, 'name'], pathToFileURL(path.join(home, 'plugins/local-model-switch-client/index.mjs')).href);
    }
    if (entry.id === 'dsh-delete-chat') {
      doc.setIn([i, 'insert', j, 'id'], 'archived-chat-delete');
      doc.setIn([i, 'insert', j, 'name'], pathToFileURL(path.join(home, 'plugins/archived-chat-delete/index.mjs')).href);
    }
  }
  return String(doc);
}

for (const oldId of ['windows-model-switch-client', 'local-model-switch-client']) {
  test(`known ${oldId} and archived-chat-delete registrations migrate once and rollback restores them`, () => fixture(({ home, profiles, sourceRoot }) => {
    const original = legacyProfile(home, oldId);
    for (const profile of profiles) fs.writeFileSync(profile.filename, original);
    const legacyFiles = ['local-model-switch-client', 'archived-chat-delete'].map(directory => {
      const filename = path.join(home, 'plugins', directory, 'index.mjs');
      fs.mkdirSync(path.dirname(filename), { recursive: true }); fs.writeFileSync(filename, `legacy ${directory}`);
      return filename;
    });
    const configFile = path.join(home, 'local-model-switch-client.json');
    const other = { ...fixtureHost, id: 'office', label: 'Other host', provider: 'windows-office', credentialRef: 'DSH_SWITCH_OFFICE_KEY',
      url: 'http://192.168.50.11:8083', gatewayId: '22222222-2222-4222-8222-222222222222' };
    fs.writeFileSync(configFile, JSON.stringify({ version: 2, hosts: [fixtureHost, other] }));
    fs.writeFileSync(path.join(home, '.credentials.yaml'), 'version: 1\nrefs:\n  CLOUD_KEY: fixture-cloud\n  DSH_SWITCH_LAB_KEY: fixture-gateway\n  DSH_SWITCH_OFFICE_KEY: fixture-office\n');
    const beforeConfig = fs.readFileSync(configFile);
    const beforeCredentials = fs.readFileSync(path.join(home, '.credentials.yaml'));
    const archiveRoots = Object.fromEntries(profiles.map(profile => [profile.name, path.join(home, 'verified-packages')]));
    const changes = buildInstallPlan({ home, profiles, sourceRoot, host: fixtureHost, key: 'fixture-gateway', archiveRoots });
    assert.ok(changes.every(row => !legacyFiles.includes(row.filename)), 'old runtime files must not be touched');
    const backupRoot = path.join(home, 'backups/migration');
    applyTransaction(changes, { home, backupRoot, closedCheck() {} });
    for (const profile of profiles) {
      const text = fs.readFileSync(profile.filename, 'utf8');
      const rows = YAML.parse(text, options);
      const entries = rows.flatMap(row => row.insert || []);
      assert.equal(entries.length, 2);
      assert.deepEqual(entries.map(entry => entry.id), ['dsh-model-switcher', 'dsh-delete-chat']);
      for (const entry of entries) assert.equal(entry.name, pathToFileURL(path.join(home, 'plugins', entry.id, 'index.mjs')).href);
      assert.equal(rows.find(row => row.id === 'agent-default-model').config.provider, 'my-cloud');
      assert.match(text, /# existing user comment/); assert.match(text, /!!js custom.expression/);
    }
    const hosts = JSON.parse(fs.readFileSync(configFile, 'utf8')).hosts;
    assert.deepEqual(hosts.find(host => host.id === 'office'), other);
    assert.deepEqual(hosts.find(host => host.id === 'lab'), fixtureHost);
    const credentials = YAML.parse(fs.readFileSync(path.join(home, '.credentials.yaml'), 'utf8'));
    assert.deepEqual(credentials.refs, { CLOUD_KEY: 'fixture-cloud', DSH_SWITCH_LAB_KEY: 'fixture-gateway', DSH_SWITCH_OFFICE_KEY: 'fixture-office' });
    assert.equal(buildInstallPlan({ home, profiles, sourceRoot, host: fixtureHost, key: 'fixture-gateway', archiveRoots }).length, 0);
    for (const filename of legacyFiles) assert.match(fs.readFileSync(filename, 'utf8'), /^legacy /);
    rollback(backupRoot, { home, closedCheck() {} });
    for (const profile of profiles) assert.equal(fs.readFileSync(profile.filename, 'utf8'), original);
    assert.deepEqual(fs.readFileSync(configFile), beforeConfig);
    assert.deepEqual(fs.readFileSync(path.join(home, '.credentials.yaml')), beforeCredentials);
    for (const filename of legacyFiles) assert.match(fs.readFileSync(filename, 'utf8'), /^legacy /);
    assert.equal(fs.existsSync(path.join(home, 'plugins/dsh-model-switcher/index.mjs')), false);
    assert.equal(fs.existsSync(path.join(home, 'plugins/dsh-delete-chat/index.mjs')), false);
  }));
}

test('migration refuses duplicate old/new registrations and redirected legacy files', () => fixture(({ home }) => {
  const original = legacyProfile(home);
  const model = { host: fixtureHost, pluginPath: path.join(home, 'plugins/dsh-model-switcher') };
  const archive = { pluginPath: path.join(home, 'plugins/dsh-delete-chat'), packageRoot: path.join(home, 'verified') };
  for (const [legacyId, canonicalId, configure, config] of [
    ['windows-model-switch-client', 'dsh-model-switcher', configureProfile, model],
    ['archived-chat-delete', 'dsh-delete-chat', configureArchiveProfile, archive],
  ]) {
    const rows = YAML.parse(original, options);
    const entry = rows.flatMap(row => row.insert || []).find(item => item.id === legacyId);
    rows.push({ insert: [{ ...entry, id: canonicalId }] });
    assert.throws(() => configure(YAML.stringify(rows), config), /Duplicate/);
    rows.pop(); entry.name = pathToFileURL(path.join(home, 'some-other-plugin/index.mjs')).href;
    assert.throws(() => configure(YAML.stringify(rows), config), /unexpected/);
  }
}));

test('unverified legacy archive registration cannot bypass runtime discovery', () => fixture(({ home, profiles }) => {
  fs.writeFileSync(profiles[1].filename, legacyProfile(home));
  assert.equal(hasArchivePlugin(fs.readFileSync(profiles[1].filename, 'utf8')), true);
  assert.throws(() => discoverArchiveRoots(profiles, { appBundle: path.join(home, 'Harness.app') }), /web profile already/);
}));

test('runtime discovery resolves published CLI entry and does not guess wrappers', () => fixture(({ home }) => {
  const cli = path.join(home, 'node_modules/@deepseek-ai/dsh/lib/bin.js');
  assert.equal(discoverCliPackageRoot({ executable: 'dsh', realpath: () => cli }), path.join(home, 'node_modules/@deepseek-ai'));
  assert.equal(discoverCliPackageRoot({ executable: 'dsh', realpath: () => path.join(home, 'unrelated-wrapper') }), null);
  assert.equal(discoverCliPackageRoot({ explicit: path.join(home, 'explicit') }), path.join(home, 'explicit'));
  assert.throws(() => discoverCliPackageRoot({ explicit: 'relative-path' }), /absolute/);
}));

test('desktop uses its app while other profiles require a verified CLI root', () => fixture(({ home, profiles }) => {
  const appBundle = path.join(home, 'Applications/DeepSeek Harness.app');
  const cliPackageRoot = path.join(home, 'cli/@deepseek-ai');
  const onlyApp = discoverArchiveRoots(profiles, { appBundle });
  assert.deepEqual(Object.keys(onlyApp.roots), ['desktop']); assert.equal(onlyApp.skipped.length, 2);
  const all = discoverArchiveRoots(profiles, { appBundle, cliPackageRoot });
  assert.equal(all.roots.desktop, path.join(appBundle, 'Contents/Resources/app.asar/dsh/node_modules/@deepseek-ai'));
  assert.equal(all.roots.web, cliPackageRoot); assert.equal(all.roots.headless, cliPackageRoot);
  assert.deepEqual(Object.keys(discoverArchiveRoots(profiles, { cliPackageRoot }).roots), ['web', 'headless']);
}));

test('an existing archive plugin in an unverified profile blocks a partial runtime upgrade', () => fixture(({ home, profiles }) => {
  const configured = configureArchiveProfile(profileSource, {
    pluginPath: path.join(home, 'plugins/dsh-delete-chat'), packageRoot: path.join(home, 'older-cli'),
  }).output;
  fs.writeFileSync(profiles[1].filename, configured);
  assert.throws(() => discoverArchiveRoots(profiles, { appBundle: path.join(home, 'Harness.app') }), /web profile already/);
}));

test('archive-only plan does not parse or change credentials, model config or providers', () => fixture(({ home, profiles, sourceRoot }) => {
  fs.writeFileSync(path.join(home, '.credentials.yaml'), 'intentionally malformed: [');
  fs.writeFileSync(path.join(home, 'local-model-switch-client.json'), 'intentionally malformed JSON');
  const roots = { desktop: path.join(home, 'native-packages') };
  const plan = buildInstallPlan({ home, profiles, sourceRoot, selected: pluginSelection('archive-delete'), archiveRoots: roots });
  assert.ok(plan.every(row => !row.filename.endsWith('.credentials.yaml') && !row.filename.endsWith('local-model-switch-client.json')));
  assert.equal(plan.filter(row => profiles.some(profile => row.filename === profile.filename)).length, 1);
  assert.equal(plan.filter(row => row.filename.includes(`${path.sep}plugins${path.sep}dsh-delete-chat${path.sep}`)).length, 8);
  const changedProfile = YAML.parse(plan.find(row => row.filename === profiles[0].filename).content, options);
  assert.deepEqual(changedProfile.slice(0, 3), YAML.parse(profileSource, options));
}));

test('model-only plan does not need archive files or package discovery', () => fixture(({ home, profiles, sourceRoot, fakeArchive }) => {
  const resolved = path.resolve(fakeArchive); assert.ok(resolved.startsWith(path.resolve(sourceRoot) + path.sep));
  fs.rmSync(resolved, { recursive: true });
  const plan = buildInstallPlan({ home, profiles, sourceRoot, selected: pluginSelection('model-switch'), host: fixtureHost, key: 'fixture-only-secret' });
  assert.equal(plan.some(row => row.filename.includes(`${path.sep}dsh-delete-chat${path.sep}`)), false);
  assert.equal(plan.filter(row => profiles.some(profile => row.filename === profile.filename)).length, 3);
  assert.ok(plan.some(row => row.filename.endsWith('.credentials.yaml')));
}));

test('combined installation and rollback preserve all prior settings together', () => fixture(({ home, profiles, sourceRoot }) => {
  const credentials = 'version: 1\nrefs:\n  CLOUD_KEY: fixture-cloud\n';
  fs.writeFileSync(path.join(home, '.credentials.yaml'), credentials);
  const before = new Map([...profiles.map(row => [row.filename, fs.readFileSync(row.filename)]),
    [path.join(home, '.credentials.yaml'), Buffer.from(credentials)]]);
  const changes = buildInstallPlan({ home, profiles, sourceRoot, host: fixtureHost, key: 'fixture-gateway',
    archiveRoots: { desktop: path.join(home, 'native-packages') } });
  const backupRoot = path.join(home, 'backups', 'combined-test');
  applyTransaction(changes, { home, backupRoot, closedCheck() {}, metadata: { plugins: 'both', safety: 'fixture' } });
  const desktop = YAML.parse(fs.readFileSync(profiles[0].filename, 'utf8'), options);
  assert.equal(desktop.flatMap(row => row.insert || []).filter(row => ['dsh-delete-chat', 'dsh-model-switcher'].includes(row.id)).length, 2);
  assert.equal(desktop[1].config.provider, 'my-cloud');
  assert.equal(YAML.parse(fs.readFileSync(path.join(home, '.credentials.yaml'), 'utf8')).refs.CLOUD_KEY, 'fixture-cloud');
  for (const plugin of ['dsh-delete-chat', 'dsh-model-switcher']) {
    assert.deepEqual(fs.readFileSync(path.join(home, 'plugins', plugin, 'LICENSE')),
      fs.readFileSync(path.join(sourceRoot, 'plugins', plugin, 'LICENSE')));
  }
  assert.equal(JSON.parse(fs.readFileSync(path.join(backupRoot, 'manifest.json'), 'utf8')).metadata.plugins, 'both');
  rollback(backupRoot, { home, closedCheck() {} });
  for (const [filename, bytes] of before) assert.deepEqual(fs.readFileSync(filename), bytes);
  assert.equal(fs.existsSync(path.join(home, 'plugins/dsh-delete-chat/index.mjs')), false);
}));

test('a failed combined write restores previously changed profiles and credentials', () => fixture(({ home, profiles, sourceRoot }) => {
  const changes = buildInstallPlan({ home, profiles, sourceRoot, host: fixtureHost, key: 'fixture-gateway', archiveRoots: { desktop: path.join(home, 'native') } });
  const before = profiles.map(row => fs.readFileSync(row.filename, 'utf8'));
  let calls = 0;
  assert.throws(() => applyTransaction(changes, { home, backupRoot: path.join(home, 'backups/failure'), closedCheck() { if (++calls === 5) throw new Error('fixture process restarted'); } }), /restarted/);
  profiles.forEach((row, index) => assert.equal(fs.readFileSync(row.filename, 'utf8'), before[index]));
  assert.equal(fs.existsSync(path.join(home, '.credentials.yaml')), false);
}));

test('package hash check rejects an unknown build before native execution', () => fixture(({ home }) => {
  const packageRoot = path.join(home, 'packages'), jsonl = path.join(packageRoot, 'dsh-session-persistence-jsonl');
  fs.mkdirSync(path.join(jsonl, 'lib'), { recursive: true });
  fs.writeFileSync(path.join(jsonl, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh-session-persistence-jsonl', version: '0.2.2-rc.1' }));
  fs.writeFileSync(path.join(jsonl, 'lib/index.js'), 'unverified code');
  assert.throws(() => verifyArchivePackages(packageRoot), /has not been verified/);
}));

test('native safety proof is required and bounded without printing private environment', () => fixture(({ home, sourceRoot }) => {
  let invocation;
  const proof = runArchiveSmokeTest(path.join(home, 'packages'), { sourceRoot, runtime: 'fixture-node', runner(...args) {
    invocation = args; return JSON.stringify({ ok: true, checks: 3, platform: process.platform });
  } });
  assert.equal(proof.ok, true); assert.equal(invocation[0], 'fixture-node');
  assert.ok(invocation[1][0].endsWith('self-test.mjs'));
  assert.equal(invocation[2].env.DSH_DELETE_TEST_PACKAGE_ROOT, path.join(home, 'packages'));
  assert.equal(invocation[2].timeout, 90000); assert.equal(invocation[2].windowsHide, true);
  for (const output of ['no proof', '{"ok":false}', JSON.stringify({ ok: true, checks: 3, platform: 'other-os' })]) {
    assert.throws(() => runArchiveSmokeTest(home, { sourceRoot, runner: () => output }), /safety test/);
  }
  assert.throws(() => runArchiveSmokeTest(home, { sourceRoot, runner: () => { throw new Error('private child details'); } }), /failed or timed out/);
}));

test('rollback preserves newer edits instead of discarding them', () => fixture(({ home, profiles }) => {
  const filename = profiles[0].filename, backupRoot = path.join(home, 'backups/newer');
  applyTransaction([{ filename, content: '[]\n' }], { home, backupRoot, closedCheck() {} });
  fs.writeFileSync(filename, '# newer edit\n[]\n');
  assert.throws(() => rollback(backupRoot, { home, closedCheck() {} }), /changed since installation/);
  assert.match(fs.readFileSync(filename, 'utf8'), /newer edit/);
}));

test('running-process checks include renamed apps, helper processes, custom CLI and other installers', () => fixture(({ home }) => {
  const appBundle = path.join(home, 'Apps/Custom Harness.app'), cliPackageRoot = path.join(home, 'custom-packages');
  const context = { pid: 40, appBundle, cliPackageRoot };
  const app = path.join(appBundle, 'Contents/MacOS/Custom Harness');
  assert.equal(harnessProcessesRunning(`40 ${app} /fixture/install.mjs\n`, context), false, 'own installer is allowed');
  assert.equal(harnessProcessesRunning(`41 ${app}\n`, context), true);
  assert.equal(harnessProcessesRunning(`41 ${app} /fixture/install.mjs\n`, context), true, 'another installer is blocked');
  assert.equal(harnessProcessesRunning(`42 ${path.join(appBundle, 'Contents/Frameworks/Harness Helper.app/Contents/MacOS/helper')}\n`, context), true);
  assert.equal(harnessProcessesRunning(`43 node ${path.join(cliPackageRoot, 'dsh/lib/bin.js')} web\n`, context), true);
  assert.equal(harnessProcessesRunning('45 dsh plugin add github:example/plugin\n', context), true);
  assert.equal(harnessProcessesRunning('44 /Applications/Other.app/Contents/MacOS/Other\n', context), false);
}));

function nativeFixture(profile, ids) {
  const profileDir = path.dirname(profile.filename);
  fs.writeFileSync(path.join(profileDir, 'package.json'), JSON.stringify({
    dependencies: Object.fromEntries(ids.map(id => [id, `github:example/${id}`])), dsh: { profile: { bundles: ids } },
  }));
  for (const id of ids) fs.cpSync(path.join(import.meta.dirname, 'plugins', id), path.join(profileDir, 'node_modules', id), { recursive: true });
}

test('native setup migrates known file plugins once and rollback leaves package-manager files intact', () => fixture(({ home, profiles }) => {
  const ids = ['dsh-model-switcher', 'dsh-delete-chat'];
  const original = legacyProfile(home);
  for (const profile of profiles) { fs.writeFileSync(profile.filename, original); nativeFixture(profile, ids); }
  assert.deepEqual(selectInstallProfiles(profiles), profiles, 'the suite retains all-profile behavior');
  const archiveRoots = Object.fromEntries(profiles.map(profile => [profile.name, path.join(home, 'verified-packages')]));
  const plan = buildInstallPlan({ home, profiles, host: fixtureHost, key: 'fixture-gateway', archiveRoots });
  assert.ok(plan.every(row => !row.filename.startsWith(path.join(home, 'plugins') + path.sep)), 'native setup must not copy another runtime');
  const backupRoot = path.join(home, 'backups/native-migration');
  applyTransaction(plan, { home, backupRoot, closedCheck() {} });
  for (const profile of profiles) {
    const output = fs.readFileSync(profile.filename, 'utf8');
    const rows = YAML.parse(output, options);
    assert.equal(rows.flatMap(row => row.insert || []).length, 0);
    for (const id of ids) {
      const matches = rows.filter(row => row.id === `${id}-bundle`);
      assert.equal(matches.length, 1); assert.equal(matches[0].name, id); assert.equal(matches[0].disabled, false);
      assert.deepEqual(matches[0].config, id === 'dsh-delete-chat' ? { packageRoot: archiveRoots[profile.name] } : {});
    }
    assert.match(output, /# existing user comment/); assert.match(output, /!!js custom.expression/);
    assert.equal(rows.find(row => row.id === 'agent-default-model').config.provider, 'my-cloud');
  }
  assert.equal(buildInstallPlan({ home, profiles, host: fixtureHost, key: 'fixture-gateway', archiveRoots }).length, 0);
  rollback(backupRoot, { home, closedCheck() {} });
  for (const profile of profiles) {
    assert.equal(fs.readFileSync(profile.filename, 'utf8'), original);
    for (const id of ids) assert.ok(fs.existsSync(path.join(path.dirname(profile.filename), 'node_modules', id, 'index.mjs')));
  }
}));

test('native package discovery rejects unselected, duplicate, redirected and modified bundles', () => fixture(({ profiles }) => {
  const profile = profiles[0], id = 'dsh-delete-chat'; nativeFixture(profile, [id]);
  const profileFile = path.join(path.dirname(profile.filename), 'package.json');
  const packageDir = path.join(path.dirname(profile.filename), 'node_modules', id);
  const packageFile = path.join(packageDir, 'package.json');
  const originalProfile = fs.readFileSync(profileFile, 'utf8'), originalPackage = fs.readFileSync(packageFile, 'utf8');
  assert.equal(discoverNativeBundle(profile, id).loaderId, `${id}-bundle`);
  const renamedMetadata = JSON.parse(originalPackage); renamedMetadata.repository = { url: 'https://github.com/example/export' }; renamedMetadata.scripts = { test: 'different exporter test command' };
  fs.writeFileSync(packageFile, JSON.stringify(renamedMetadata));
  assert.ok(discoverNativeBundle(profile, id), 'release metadata may differ without changing runtime identity');
  fs.writeFileSync(packageFile, originalPackage);
  for (const mutate of [record => { delete record.dependencies[id]; }, record => { record.dsh.profile.bundles = []; },
    record => { record.dsh.profile.bundles.push(id); }]) {
    const changed = JSON.parse(originalProfile); mutate(changed); fs.writeFileSync(profileFile, JSON.stringify(changed));
    assert.throws(() => discoverNativeBundle(profile, id), /do not agree|Enable now/);
  }
  fs.writeFileSync(profileFile, originalProfile);
  for (const mutate of [record => { record.name = 'unrelated'; }, record => { record.dsh.bundle.patch = '../other.yml'; },
    record => { record.exports['.'] = './unexpected.mjs'; }]) {
    const changed = JSON.parse(originalPackage); mutate(changed); fs.writeFileSync(packageFile, JSON.stringify(changed));
    assert.throws(() => discoverNativeBundle(profile, id), /does not match/);
  }
  fs.writeFileSync(packageFile, originalPackage);
  for (const name of ['cordis.patch.yml', 'index.mjs']) {
    const filename = path.join(packageDir, name), bytes = fs.readFileSync(filename);
    fs.writeFileSync(filename, name.endsWith('.yml') ? '- insert: [{id: dsh-delete-chat-bundle, name: dsh-delete-chat, disabled: false}]\n' : 'export const changed = true;');
    assert.throws(() => discoverNativeBundle(profile, id), /does not match/);
    fs.writeFileSync(filename, bytes);
  }
}));

test('native profile edits reject unknown ownership and duplicates before changing a plan', () => fixture(({ home, profiles }) => {
  nativeFixture(profiles[0], ['dsh-delete-chat']);
  const nativeBundle = discoverNativeBundle(profiles[0], 'dsh-delete-chat');
  const config = { pluginPath: path.join(home, 'plugins/dsh-delete-chat'), packageRoot: path.join(home, 'verified'), nativeBundle };
  for (const source of [
    '- id: dsh-delete-chat-bundle\n  name: unrelated\n',
    '- id: dsh-delete-chat-bundle\n  config: {extra: true}\n',
    '- id: dsh-delete-chat-bundle\n- id: dsh-delete-chat-bundle\n',
    '- id: another-id\n  name: dsh-delete-chat\n',
    '- insert: [{id: dsh-delete-chat, name: "file:///unowned/index.mjs"}]\n',
    YAML.stringify([{ insert: [{ id: 'custom-delete-button', name: pathToFileURL(path.join(home, 'plugins/dsh-delete-chat/index.mjs')).href }] }]),
    YAML.stringify([{ insert: [{ id: 'custom-delete-button', name: pathToFileURL(path.join(home, 'plugins/archived-chat-delete/index.mjs')).href }] }]),
    YAML.stringify([{ insert: [{ id: 'group', name: 'cordis:group', config: [{ id: 'dsh-delete-chat', name: 'dsh-delete-chat' }] }] }]),
    YAML.stringify([{ insert: [{ id: 'group', name: 'cordis:group', config: [{ id: 'custom-delete-button', name: pathToFileURL(path.join(home, 'plugins/dsh-delete-chat/index.mjs')).href }] }] }]),
  ]) assert.throws(() => configureArchiveProfile(source, config), /Unexpected|unexpected|Duplicate|nested/);
  const initial = '- id: dsh-delete-chat-bundle\n  disabled: true\n';
  const enabled = configureArchiveProfile(initial, config).output;
  assert.deepEqual(YAML.parse(enabled), [{ id: 'dsh-delete-chat-bundle', name: 'dsh-delete-chat', disabled: false, config: { packageRoot: config.packageRoot } }]);
  assert.equal(configureArchiveProfile(enabled, config).changed, false);
  assert.equal(hasArchivePlugin(enabled), true);
}));

test('rollback rejects traversal, duplicate targets and unsafe permission records before writes', () => fixture(({ home, profiles }) => {
  const filename = profiles[0].filename, backupRoot = path.join(home, 'backups/tampered');
  applyTransaction([{ filename, content: '[]\n' }], { home, backupRoot, closedCheck() {} });
  const manifestPath = path.join(backupRoot, 'manifest.json'), original = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  for (const mutate of [record => { record.files[0].before = '../other'; }, record => { record.files.push(record.files[0]); },
    record => { record.files[0].mode = 0o7777; }]) {
    const modified = structuredClone(original); mutate(modified); fs.writeFileSync(manifestPath, JSON.stringify(modified));
    assert.throws(() => rollback(backupRoot, { home, closedCheck() {} }), /Invalid|duplicate/);
    assert.equal(fs.readFileSync(filename, 'utf8'), '[]\n');
  }
}));

test('rollback rechecks the runtime recorded in the selected backup', () => fixture(({ home, profiles }) => {
  const filename = profiles[0].filename, backupRoot = path.join(home, 'backups/runtime'), appBundle = path.join(home, 'Earlier Harness.app');
  applyTransaction([{ filename, content: '[]\n' }], { home, backupRoot, closedCheck() {}, metadata: { appBundle } });
  assert.throws(() => rollback(backupRoot, { home, closedCheck(metadata = {}) { if (metadata.appBundle === appBundle) throw new Error('earlier app still running'); } }), /still running/);
  assert.equal(fs.readFileSync(filename, 'utf8'), '[]\n');
}));
