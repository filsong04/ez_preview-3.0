'use strict';
const fs = require('node:fs');
const path = require('node:path');
const pkg = require('../package.json');

const required = [
  'index.html', 'main.cjs', 'assets/bundled-dji-dlogm.cube', 'preload.cjs', 'package.json', '.gitattributes',
  'build/icon.icns', 'build/icon.ico', 'build/icon.png', 'build/icon.svg',
  'build/ez-logo-original.png', 'THIRD_PARTY_NOTICES.md', '.github/workflows/build-release.yml', 'scripts/write-checksums.cjs', 'scripts/run-native-smoke-tests.cjs', 'scripts/smoke-test-brand-assets.cjs'
];
const missing = required.filter(file => !fs.existsSync(path.join(__dirname, '..', file)));
const issues = [];
if (!pkg.name || !pkg.version || !pkg.build || !pkg.build.appId) issues.push('Missing package identity/version/build configuration.');
if (!String(pkg.version).includes('-rc.')) issues.push('This release-prep workflow should use a release-candidate version (for example 1.0.0-rc.3).');
if (pkg.devDependencies?.electron !== '44.9.0') issues.push('Modern build Electron version is not the reviewed release-candidate target 44.9.0.');
if (pkg.devDependencies?.['electron-builder'] !== '26.17.0') issues.push('electron-builder version differs from the locked release-candidate target 26.17.0.');
if (!Array.isArray(pkg.build?.asarUnpack) || !pkg.build.asarUnpack.some(x => String(x).includes('ffmpeg-static'))) issues.push('FFmpeg static binary must remain unpacked from ASAR.');
if (!pkg.build?.mac?.icon || !pkg.build?.win?.icon) issues.push('Platform app icons are missing from build configuration.');
if (!Array.isArray(pkg.build?.mac?.binaries) || !pkg.build.mac.binaries.some(x => String(x).includes('ffmpeg-static'))) issues.push('Bundled FFmpeg executable must be declared for macOS signing.');
if (missing.length || issues.length) {
  if (missing.length) console.error('Missing release files:\n- ' + missing.join('\n- '));
  if (issues.length) console.error('Release preflight issues:\n- ' + issues.join('\n- '));
  process.exit(1);
}
console.log(`Release preflight passed for ${pkg.productName || 'EZ Preview'} ${pkg.version}.`);
console.log(`Modern build: Electron ${pkg.devDependencies.electron}; electron-builder ${pkg.devDependencies['electron-builder']}.`);
if (!fs.existsSync(path.join(__dirname, '..', 'package-lock.json'))) {
  console.warn('WARNING: package-lock.json is not committed in this source bundle. CI resolves a shared transient lock for RC builds; commit a reviewed lockfile before the stable 1.0.0 release.');
}
console.log('NOTE: This is a release candidate, not a public-release approval. Verify signing, notarization, EULA/copyright ownership, and FFmpeg licensing before charging users.');
