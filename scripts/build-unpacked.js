/**
 * Builds two unpacked extension directories (Chrome and Firefox) so you can load
 * both in their browser at the same time without switching manifest.
 * Output: dist/chrome/ and dist/firefox/
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const DIST = path.join(ROOT, 'dist');

const SHARED_FILES = ['background.js', 'content.js'];
const SHARED_DIRS = ['icons', 'lib', 'sidepanel'];

function copyDir(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDir(s, d);
    } else {
      fs.copyFileSync(s, d);
    }
  }
}

function buildTarget(name, manifestSource) {
  const out = path.join(DIST, name);
  fs.mkdirSync(out, { recursive: true });

  fs.copyFileSync(path.join(ROOT, manifestSource), path.join(out, 'manifest.json'));
  for (const f of SHARED_FILES) {
    fs.copyFileSync(path.join(ROOT, f), path.join(out, f));
  }
  for (const d of SHARED_DIRS) {
    copyDir(path.join(ROOT, d), path.join(out, d));
  }

  console.log(`  ${name}/`);
}

fs.mkdirSync(DIST, { recursive: true });
console.log('Building unpacked extensions:');
buildTarget('chrome', 'manifest.chrome.json');
buildTarget('firefox', 'manifest.firefox.json');
console.log('Done. Load dist/chrome in Chrome, dist/firefox in Firefox.');
