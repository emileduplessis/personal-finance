/* ============================================================
   Third-party guard for every HTML page.
   The privacy policy promises that loading a page doesn't contact
   Google Fonts or a script CDN: fonts live in /fonts and libraries
   in /scripts/vendor (pinned versions). This test fails if a page
   pulls a script, stylesheet or font from another host again.

   Run:  node --test tests/      (or: npm test)
   ============================================================ */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const SKIP_DIRS = new Set(['node_modules', '.git', 'design-system', 'graphify-out']);

function htmlFiles(dir = ROOT) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    if (e.isDirectory()) return SKIP_DIRS.has(e.name) ? [] : htmlFiles(path.join(dir, e.name));
    return e.name.endsWith('.html') ? [path.join(dir, e.name)] : [];
  });
}

for (const file of htmlFiles()) {
  const rel = path.relative(ROOT, file);
  test(`${rel} loads no scripts, styles or fonts from other hosts`, () => {
    const html = fs.readFileSync(file, 'utf8');
    const external = [
      ...html.matchAll(/<script[^>]*\bsrc="(https?:\/\/[^"]+)"/g),
      ...html.matchAll(/<link[^>]*\bhref="(https?:\/\/[^"]+)"[^>]*>/g),
    ]
      .filter((m) => m[0].startsWith('<script') || /\brel="(stylesheet|preload|preconnect|modulepreload)"/.test(m[0]))
      .map((m) => m[1]);
    assert.deepEqual(external, [], 'serve it from this site instead (see scripts/vendor/README.md)');
  });
}
