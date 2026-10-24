// Assembles the Firefox add-on in dist/firefox from the shared extension files plus firefox/.
// Load it in Firefox via about:debugging -> "Load Temporary Add-on" -> dist/firefox/manifest.json,
// or package it with `npx web-ext build -s dist/firefox`.

import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'dist', 'firefox');

const SHARED = [
  'popup.html',
  'popup.js',
  'styles.css',
  'rnnoise-worklet.js',
  'assets/fastenhancer_s.wasm',
  'assets/fastenhancer_t.wasm',
  'assets/rnnoise.wasm',
  'icons/icon16.png',
  'icons/icon32.png',
  'icons/icon48.png',
  'icons/icon128.png',
  'icons/NoMusic(transparent).png',
  'LICENSE'
];
const FIREFOX_ONLY = ['background.js', 'media-hook.js', 'fe-worklet.js'];

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

for (const file of SHARED) {
  mkdirSync(dirname(join(out, file)), { recursive: true });
  cpSync(join(root, file), join(out, file));
}
for (const file of FIREFOX_ONLY) cpSync(join(root, 'firefox', file), join(out, file));

// Keep the version in step with the Chrome manifest.
const chromeManifest = JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8'));
const manifest = JSON.parse(readFileSync(join(root, 'firefox', 'manifest.json'), 'utf8'));
manifest.version = chromeManifest.version;
writeFileSync(join(out, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');

console.log('Firefox add-on written to ' + out);
