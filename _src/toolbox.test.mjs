// Tests for the somov Toolbox feed. Run: node --test _src/toolbox.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildToolboxFeed } from './toolbox.mjs';

const settings = JSON.parse(readFileSync(new URL('./data/settings.json', import.meta.url), 'utf8'));
const feed = buildToolboxFeed(settings, { cdn: 'https://dl3.somov.org/', site: 'https://somov.org' });
const item = id => feed.items.find(i => i.id === id);

test('a .reg item is a reg kind with its dl3 url', () => {
  assert.equal(item('classic-notepad').kind, 'reg');
  assert.equal(item('classic-notepad').files[0].url, 'https://dl3.somov.org/notepad.reg');
});

test('browsers become one exe item with four labelled files', () => {
  const b = item('browsers');
  assert.equal(b.kind, 'exe');
  assert.equal(b.files.length, 4);
  assert.equal(b.files[0].label, 'Google Chrome');
  assert.equal(b.files[3].name, 'Firefox Installer.exe');
});

test('an archive with a run file keeps it', () => {
  assert.equal(item('vcpp-runtimes').kind, 'archive');
  assert.equal(item('vcpp-runtimes').run, 'install_all.bat');
  assert.equal(item('acrobat-reader').run, 'INSTALLx64.cmd');
});

test('commands, info and link kinds', () => {
  assert.equal(item('backup-drivers').kind, 'commands');
  assert.equal(item('backup-drivers').commands.length, 2);
  assert.equal(item('keyboard-shortcuts').kind, 'info');
  assert.equal(item('defrag-tools').kind, 'link');
});

test('advanced and os flags', () => {
  for (const id of ['defender-remover', 'remove-edge', 'pause-updates']) assert.equal(item(id).advanced, true, id);
  assert.equal(feed.items.filter(i => i.advanced).length, 3);
  for (const id of ['drag-and-drop', 'explorer-tabs', 'old-context-menu']) assert.equal(item(id).os, '11', id);
  assert.equal(item('turn-off-telemetry').os, '10');
  assert.equal(item('classic-notepad').os, undefined);
});

test('categories keep the site order and every item links to its page', () => {
  assert.deepEqual(feed.categories.map(c => c.id), settings.categories.map(c => c.id));
  assert.equal(feed.items.length, settings.items.length);
  for (const i of feed.items) {
    assert.ok(i.page.ru.endsWith(`/ru/tweaks/${i.id}`), i.id);
    assert.ok(i.page.en.endsWith(`/tweaks/${i.id}`), i.id);
  }
});

// Task 5: version.json and the zip for the site download
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { writeToolboxFeed } from './toolbox.mjs';

const root = new URL('..', import.meta.url).pathname.replace(/^\/([A-Z]:)/, '$1');
writeToolboxFeed(root, settings, { cdn: 'https://dl3.somov.org/', site: 'https://somov.org' });

test('version.json carries the script hash and the same version as the script', () => {
  const script = readFileSync(new URL('../toolbox/somov-toolbox.ps1', import.meta.url));
  const v = JSON.parse(readFileSync(new URL('../toolbox/version.json', import.meta.url), 'utf8'));
  assert.equal(v.sha256, createHash('sha256').update(script).digest('hex'));
  const inScript = script.toString('utf8').match(/\$ToolboxVersion = '([\d.]+)'/)[1];
  assert.equal(v.version, inScript);
});

test('the zip holds the script, the launcher and the offline list', () => {
  const zip = new URL('../toolbox/somov-toolbox.zip', import.meta.url);
  assert.ok(existsSync(zip));
  const list = execFileSync('C:/Windows/System32/tar.exe', ['-tf', zip.pathname.replace(/^\/([A-Z]:)/, '$1')], { encoding: 'utf8' });
  for (const f of ['somov-toolbox.ps1', 'Start somov Toolbox.cmd', 'items.json']) assert.ok(list.includes(f), f);
});
