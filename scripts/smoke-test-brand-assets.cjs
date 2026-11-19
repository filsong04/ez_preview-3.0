'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.join(__dirname, '..');
const build = path.join(root, 'build');
const read = name => fs.readFileSync(path.join(build, name));

const png = read('icon.png');
assert.ok(png.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])), 'icon.png must have a valid PNG signature');
assert.equal(png.readUInt32BE(16), 1024, 'master PNG width must be 1024');
assert.equal(png.readUInt32BE(20), 1024, 'master PNG height must be 1024');

const ico = read('icon.ico');
assert.equal(ico.readUInt16LE(0), 0, 'ICO reserved field must be zero');
assert.equal(ico.readUInt16LE(2), 1, 'ICO image type must be 1');
assert.ok(ico.readUInt16LE(4) >= 6, 'ICO should include multiple resolutions');
for (let i = 0; i < ico.readUInt16LE(4); i++) {
  const entry = 6 + i * 16;
  const size = ico.readUInt32LE(entry + 8);
  const offset = ico.readUInt32LE(entry + 12);
  assert.ok(size > 0 && offset + size <= ico.length, `ICO image entry ${i} must point inside file`);
}

const icns = read('icon.icns');
assert.equal(icns.toString('ascii', 0, 4), 'icns', 'ICNS signature missing');
assert.equal(icns.readUInt32BE(4), icns.length, 'ICNS outer length must match file size');
const chunks = [];
let offset = 8;
while (offset < icns.length) {
  assert.ok(offset + 8 <= icns.length, 'ICNS chunk header is truncated');
  const type = icns.toString('ascii', offset, offset + 4);
  const length = icns.readUInt32BE(offset + 4);
  assert.ok(length >= 8 && offset + length <= icns.length, `ICNS chunk ${type} has invalid length`);
  chunks.push({ type, offset, length });
  offset += length;
}
for (const type of ['icp4','icp5','icp6','ic07','ic08','ic09','ic10']) assert.ok(chunks.some(chunk => chunk.type === type), `ICNS is missing ${type}`);
const largePngChunk = chunks.find(chunk => chunk.type === 'ic10');
assert.ok(largePngChunk && icns.subarray(largePngChunk.offset + 8, largePngChunk.offset + 16).equals(Buffer.from([137,80,78,71,13,10,26,10])), 'ICNS 1024px icon chunk should embed PNG data');

const svg = fs.readFileSync(path.join(build, 'icon.svg'), 'utf8');
assert.match(svg, /<svg[\s>]/, 'icon.svg must be an SVG document');
assert.match(svg, /data:image\/png;base64,/, 'SVG must embed the same self-contained logo artwork');
assert.ok(fs.existsSync(path.join(build, 'ez-logo-original.png')), 'original user-supplied logo should be retained');

const pkg = require('../package.json');
const workflow = fs.readFileSync(path.join(root, '.github', 'workflows', 'build-release.yml'), 'utf8');
assert.equal(pkg.version, '1.0.0-rc.6');
assert.match(workflow, /v1\.0\.0-rc\.6/, 'release artifact names must match package version');
assert.match(workflow, /npm install --no-audit --no-fund/, 'Catalina legacy profile should refresh its lockfile after changing Electron');
assert.match(pkg.build.files.join(' '), /!PUBLISH-RC3\.md/, 'the repository publishing guide must not be copied into the installed app');
assert.equal(pkg.build.mac.icon, 'build/icon.icns');
assert.equal(pkg.build.win.icon, 'build/icon.ico');
assert.equal(pkg.build.linux.icon, 'build/icon.png');
console.log('PASS: EZ logo icon assets (PNG/ICO/ICNS/SVG), original artwork, and packaging configuration.');
