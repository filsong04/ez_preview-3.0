'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');

const directory = path.resolve(process.argv[2] || 'release');
if (!fs.existsSync(directory) || !fs.statSync(directory).isDirectory()) {
  console.error(`Release output directory does not exist: ${directory}`);
  process.exit(1);
}
const files = fs.readdirSync(directory)
  .filter(name => name !== 'SHA256SUMS.txt')
  .map(name => ({ name, path: path.join(directory, name) }))
  .filter(item => fs.existsSync(item.path) && fs.statSync(item.path).isFile())
  .sort((a, b) => a.name.localeCompare(b.name));
if (!files.length) {
  console.error(`No files found in release output directory: ${directory}`);
  process.exit(1);
}
const lines = files.map(item => {
  const hash = createHash('sha256').update(fs.readFileSync(item.path)).digest('hex');
  return `${hash}  ${item.name}`;
});
const output = path.join(directory, 'SHA256SUMS.txt');
fs.writeFileSync(output, `${lines.join('\n')}\n`, 'utf8');
console.log(`Wrote ${output} for ${files.length} release file(s).`);
