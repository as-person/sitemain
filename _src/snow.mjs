#!/usr/bin/env node
// The winter snow of the whole site, then a rebuild. Publish with GitPush afterwards.
//   node _src/snow.mjs auto   every year by itself from 15 December to 31 January (dates in _src/data/snow.json)
//   node _src/snow.mjs on     right now and always, whatever the date
//   node _src/snow.mjs off    never: no snow, no footer link, the snow file is not even loaded
//   node _src/snow.mjs        tells which it is now
import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const file = join(here, 'data', 'snow.json');
const data = JSON.parse(readFileSync(file, 'utf8'));
const say = () => (data.mode === 'auto' ? `AUTO (every year ${data.from} .. ${data.to}, month-day)` : data.mode.toUpperCase());
const wish = process.argv[2];
if (!['auto', 'on', 'off'].includes(wish)) {
  console.log(`Snow: ${say()}. Use: node _src/snow.mjs auto | on | off`);
  process.exit(0);
}
data.mode = wish;
writeFileSync(file, JSON.stringify(data, null, 2) + '\n');
execFileSync(process.execPath, [join(here, 'build.mjs')], { stdio: 'inherit' });
console.log(`Snow: ${say()}. Now publish it: GitPush`);
