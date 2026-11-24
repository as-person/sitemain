#!/usr/bin/env node
// The owner's stat lines on the site (only the owner sees them anyway), then a rebuild. Publish with GitPush afterwards.
//   node _src/owner-stats.mjs on    show them (to the owner's IP or device key)
//   node _src/owner-stats.mjs off   hide them for the owner too; counting goes on, https://dl3.somov.org/stats/ stays
//   node _src/owner-stats.mjs       tells which it is now
import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const file = join(here, 'data', 'owner-stats.json');
const data = JSON.parse(readFileSync(file, 'utf8'));
const say = () => (data.show ? 'ON (shown to the owner)' : 'OFF (hidden)');
const [wish] = process.argv.slice(2);
if (!['on', 'off'].includes(wish)) {
  console.log(`Stats on the site: ${say()}. Use: node _src/owner-stats.mjs on | off`);
  process.exit(0);
}
data.show = wish === 'on';
writeFileSync(file, JSON.stringify(data, null, 2) + '\n');
execFileSync(process.execPath, [join(here, 'build.mjs')], { stdio: 'inherit' });
console.log(`Stats on the site: ${say()}. Now publish it: GitPush`);
