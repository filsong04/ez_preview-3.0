'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8').replace(/\r\n?/g, '\n');
const inline = html.match(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/i)?.[1];
assert.ok(inline, 'renderer script should exist');

// Run the actual pure translation map/function from the shipped renderer.
const translationStart = inline.indexOf('  const translationPairs = [');
const translationEnd = inline.indexOf('  function isProtectedLanguageNode(node) {', translationStart);
assert.ok(translationStart >= 0 && translationEnd > translationStart, 'translation block should be present');
const translationBlock = inline.slice(translationStart, translationEnd);
const translationContext = {};
vm.createContext(translationContext);
vm.runInContext(`${translationBlock}\nthis.translateCore = translateCore;`, translationContext);
assert.equal(translationContext.translateCore('MEDIA LIBRARY', 'ko'), '미디어 라이브러리');
assert.equal(translationContext.translateCore('미디어 라이브러리', 'en'), 'MEDIA LIBRARY');
assert.equal(translationContext.translateCore('6 clips', 'ko'), '6개 클립');
assert.equal(translationContext.translateCore('변환 중 · 49 frames', 'en'), 'Preparing · 49 frames');
assert.equal(translationContext.translateCore('MP4 · MOV · MXF · MKV · AVI · Camera files*', 'ko'), 'MP4 · MOV · MXF · MKV · AVI · 카메라 영상*');
assert.equal(translationContext.translateCore('Bundled LUT payload: seeded into the persistent browser library once.', 'ko'), '내장 LUT 데이터: 영구 브라우저 라이브러리에 최초 한 번 등록됩니다.');
assert.equal(translationContext.translateCore('Queued 3 clips for retry.', 'ko'), '3개 클립을 재시도 대기열에 추가했습니다.');
assert.equal(translationContext.translateCore('3개 클립을 미디어 빈에 추가했습니다. 현재 변환이 끝난 뒤 전환됩니다.', 'en'), '3 clips added to Media Bin. Switch after the current conversion finishes.');
assert.equal(translationContext.translateCore('Background proxy queue canceled. You can retry canceled items later.', 'ko'), '백그라운드 프록시 큐를 취소했습니다. 취소된 항목은 나중에 다시 시도할 수 있습니다.');
assert.equal(translationContext.translateCore('DJI_2025_001.mp4', 'ko'), 'DJI_2025_001.mp4', 'unknown user data must be unchanged');

// Exercise the actual aspect-ratio fitting helper with landscape, portrait, and square targets.
const fitStart = inline.indexOf('  function fitAspectBox(maxW, maxH, ratio) {');
const fitEnd = inline.indexOf('  function sizeVideoFrame() {', fitStart);
assert.ok(fitStart >= 0 && fitEnd > fitStart, 'aspect-fit helper should be present');
const fitContext = {};
vm.createContext(fitContext);
vm.runInContext(`${inline.slice(fitStart, fitEnd)}\nthis.fitAspectBox = fitAspectBox;`, fitContext);
const fit = fitContext.fitAspectBox;
assert.deepEqual(JSON.parse(JSON.stringify(fit(1920, 1080, 16 / 9))), { width: 1920, height: 1080 });
const portrait = fit(1920, 1080, 9 / 16);
assert.ok(portrait.width < 700 && portrait.height === 1080, '9:16 should be pillarboxed in a landscape monitor');
assert.ok(Math.abs(portrait.width / portrait.height - 9 / 16) < 0.002, 'portrait ratio should remain intact');
const square = fit(1920, 1080, 1);
assert.deepEqual(JSON.parse(JSON.stringify(square)), { width: 1080, height: 1080 });
assert.deepEqual(JSON.parse(JSON.stringify(fit(100, 100, 0))), { width: 0, height: 0 }, 'invalid ratios should not produce dimensions');

// DOM and CSS guards for the actual fullscreen media surface.
assert.match(html, /<div id="videoFrame"><div id="videoSurface">/, 'fullscreen viewport should wrap an inner media surface');
assert.match(html, /#videoFrame:fullscreen #videoSurface\{position:relative;inset:auto;flex:none/, 'fullscreen media surface should be centered inside the viewport');
for (const id of ['video', 'lutCanvas', 'fullscreenBtn', 'videoInfoOverlay', 'splitOverlay']) {
  const start = html.indexOf('<div id="videoSurface">');
  const end = html.indexOf('</div></div>\n      <div class="hud hidden"', start);
  assert.ok(start >= 0 && end > start && html.slice(start, end).includes(`id="${id}"`), `${id} should align to the fullscreen aspect-ratio surface`);
}
assert.match(html, /id="languageToggleBtn"[^>]*>EN</, 'language toggle should reflect the default active language in static markup');
assert.match(html, /button\.textContent = state\.language === 'en' \? 'EN' : 'KO'/, 'language button should display the active UI language');
assert.match(html, /button\.dataset\.language = state\.language/, 'active language should drive the button state styling');
assert.match(html, /setLutPreference\('uiLanguage', state\.language\)/, 'language should persist through native app preferences');
assert.match(html, /getLutPreference\('uiLanguage'\)/, 'language preference should be restored on launch');
assert.match(html, /document\.documentElement\.lang = state\.language/, 'document language should follow selected UI language');

const ids = [...html.matchAll(/\bid=["']([^"']+)["']/g)].map(match => match[1]);
assert.equal(new Set(ids).size, ids.length, 'HTML IDs must remain unique');
console.log('PASS: fullscreen aspect-ratio fitting, bilingual translations, user-data protection, and language preference persistence.');
