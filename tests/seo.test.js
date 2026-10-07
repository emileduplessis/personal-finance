/* ============================================================
   SEO guard for the public pages.
   Crawlers (Google, GPTBot, ClaudeBot...) read the raw HTML
   without running our JS, so everything a public page needs to
   be understood has to be in the file itself. This test reads
   every URL in sitemap.xml, resolves it to its HTML file the way
   vercel.json does, and checks the raw markup.

   Run:  node --test tests/      (or: npm test)
   ============================================================ */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const vercel = JSON.parse(read('vercel.json'));
const sitemapUrls = [...read('sitemap.xml').matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1].trim());

/* Minimum visible text in the raw HTML. Below this the page is
   probably an empty shell that JS fills in, which AI crawlers can't see. */
const MIN_TEXT_CHARS = 300;

/* URL path -> HTML file, following vercel.json rewrites + cleanUrls. */
function fileForPath(urlPath) {
  if (urlPath === '/' || urlPath === '') return 'index.html';
  const rewrite = (vercel.rewrites || []).find((r) => r.source === urlPath);
  const target = rewrite ? rewrite.destination : urlPath;
  return target.replace(/^\//, '') + '.html';
}

/* All <meta> tags as attribute maps (attribute order doesn't matter). */
function metaTags(html) {
  return [...html.matchAll(/<meta\b([^>]*)>/gi)].map((m) => {
    const attrs = {};
    for (const a of m[1].matchAll(/([\w:-]+)\s*=\s*"([^"]*)"/g)) attrs[a[1].toLowerCase()] = a[2];
    return attrs;
  });
}
const metaContent = (metas, key, value) =>
  (metas.find((m) => (m[key] || '').toLowerCase() === value) || {}).content;

function visibleText(html) {
  return html
    .replace(/<head[\s\S]*?<\/head>/i, ' ')
    .replace(/<(script|style|noscript|template|svg)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&[a-z#0-9]+;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

test('sitemap lists at least one page', () => {
  assert.ok(sitemapUrls.length > 0, 'sitemap.xml has no <loc> entries');
});

for (const url of sitemapUrls) {
  const urlPath = new URL(url).pathname;
  const file = fileForPath(urlPath);

  test(`public page ${urlPath} (${file})`, async (t) => {
    assert.ok(fs.existsSync(path.join(ROOT, file)), `${url} resolves to ${file}, which does not exist`);
    const html = read(file);
    const metas = metaTags(html);

    await t.test('has a non-empty <title>', () => {
      const title = (html.match(/<title>([^<]*)<\/title>/i) || [])[1];
      assert.ok(title && title.trim(), 'missing <title>');
    });

    await t.test('has a meta description', () => {
      const desc = metaContent(metas, 'name', 'description');
      assert.ok(desc && desc.trim().length >= 50, 'meta description missing or shorter than 50 chars');
    });

    await t.test('is not noindex', () => {
      const robots = metaContent(metas, 'name', 'robots') || '';
      assert.ok(!/noindex/i.test(robots), `has robots "${robots}" but is listed in sitemap.xml`);
    });

    await t.test('canonical matches the sitemap URL', () => {
      const canonical = (html.match(/<link\b[^>]*rel="canonical"[^>]*href="([^"]+)"/i) ||
                         html.match(/<link\b[^>]*href="([^"]+)"[^>]*rel="canonical"/i) || [])[1];
      assert.equal(canonical, url);
    });

    await t.test('has Open Graph tags for link previews', () => {
      for (const prop of ['og:title', 'og:description', 'og:image', 'og:url']) {
        const v = metaContent(metas, 'property', prop);
        assert.ok(v && v.trim(), `missing ${prop}`);
      }
    });

    await t.test(`has at least ${MIN_TEXT_CHARS} chars of text in the raw HTML`, () => {
      const len = visibleText(html).length;
      assert.ok(len >= MIN_TEXT_CHARS, `only ${len} chars of visible text; is the content injected by JS?`);
    });

    await t.test('JSON-LD blocks are valid JSON', () => {
      for (const m of html.matchAll(/<script\b[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi)) {
        assert.doesNotThrow(() => JSON.parse(m[1]), 'invalid JSON-LD');
      }
    });
  });
}

test('every HTML page is either in the sitemap or noindex', () => {
  const inSitemap = new Set(sitemapUrls.map((u) => fileForPath(new URL(u).pathname)));
  const files = [
    ...fs.readdirSync(ROOT).filter((f) => f.endsWith('.html')),
    ...fs.readdirSync(path.join(ROOT, 'pages')).filter((f) => f.endsWith('.html')).map((f) => 'pages/' + f),
  ];
  const stray = files.filter((f) => {
    if (inSitemap.has(f)) return false;
    const robots = metaContent(metaTags(read(f)), 'name', 'robots') || '';
    return !/noindex/i.test(robots);
  });
  assert.deepEqual(stray, [], 'add these to sitemap.xml, or mark them <meta name="robots" content="noindex">');
});
