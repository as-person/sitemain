// somov Toolbox feed: the Settings page items (_src/data/settings.json) turned into toolbox/items.json,
// which the toolbox window reads from https://somov.org/toolbox/. One list feeds both the site and the toolbox.
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const KIND_BY_EXT = { reg: 'reg', bat: 'script', cmd: 'script', exe: 'exe', zip: 'archive', rar: 'archive' };

const kindOf = item => {
  const first = item.file ?? item.downloads?.[0]?.file;
  if (first) return KIND_BY_EXT[first.split('.').pop().toLowerCase()] ?? 'link';
  if (item.commands) return 'commands';
  if (item.keys) return 'info';
  return 'link';
};

export function buildToolboxFeed(settings, { cdn, site }) {
  const fileEntry = (file, label) => ({ ...(label ? { label } : {}), url: `${cdn}${file}`, name: decodeURIComponent(file) });
  const items = settings.items.map(item => ({
    id: item.id,
    category: item.category,
    title: item.title,
    desc: item.desc,
    ...(item.warning ? { warning: typeof item.warning === 'string' ? { en: item.warning, ru: item.warning } : item.warning } : {}),
    advanced: item.advanced === true,
    ...(item.os ? { os: item.os } : {}),
    kind: kindOf(item),
    files: item.file ? [fileEntry(item.file)] : (item.downloads ?? []).map(d => fileEntry(d.file, d.label)),
    ...(item.run ? { run: item.run } : {}),
    ...(item.commands ? { commands: item.commands.map(c => ({ label: c.label, code: c.code })) } : {}),
    ...(item.keys ? { keys: item.keys } : {}),
    page: { en: `${site}/tweaks/${item.id}`, ru: `${site}/ru/tweaks/${item.id}` },
  }));
  return { schema: 1, categories: settings.categories.map(c => ({ id: c.id, title: c.title })), items };
}

export function writeToolboxFeed(root, settings, options) {
  const dir = join(root, 'toolbox');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'items.json'), JSON.stringify(buildToolboxFeed(settings, options), null, 1) + '\n');

  // version.json: what the installed toolboxes compare against; the hash guards the self-update
  const scriptPath = join(dir, 'somov-toolbox.ps1');
  if (!existsSync(scriptPath)) return;
  const script = readFileSync(scriptPath);
  const version = script.toString('utf8').match(/\$ToolboxVersion = '([\d.]+)'/)?.[1];
  if (!version) throw new Error('somov-toolbox.ps1: $ToolboxVersion not found');
  writeFileSync(join(dir, 'version.json'), JSON.stringify({ version, sha256: createHash('sha256').update(script).digest('hex') }) + '\n');

  // The zip for the site download: Windows' own tar makes real zip files (Git's tar does not)
  const zip = join(dir, 'somov-toolbox.zip');
  rmSync(zip, { force: true });
  execFileSync('C:/Windows/System32/tar.exe', ['-a', '-c', '-f', zip, '-C', dir, 'somov-toolbox.ps1', 'Start somov Toolbox.cmd', 'items.json']);
}
