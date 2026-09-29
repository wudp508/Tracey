// Writes the few things that must differ between sites that share this
// code: which database the pages talk to, and what a link preview says.
//
// Netlify runs this only on sites whose Build command is `node build.js`.
// Tracey's site has no build command, so for her this file is never run
// and her pages publish exactly as they are in GitHub.
//
// Settings come from the site's own environment variables in Netlify:
//
//   SUPABASE_URL      her database's address       (functions use it too)
//   SUPABASE_KEY      its PUBLISHABLE key          (functions use it too)
//   SITE_URL          the site's address           (functions use it too)
//   PAGE_TITLE        e.g. "For Susan"             link preview, tab, icon name
//   PAGE_DESCRIPTION  one line for the link preview
//   JOURNAL_TITLE     e.g. "Susan's journey"       optional
//   APPROVER, CONTACT fallback names               optional; Settings wins
//
// It is deliberately strict. The one thing that must never happen is a
// second family's pages quietly opening Tracey's database, so anything
// that looks wrong stops the build — and when a build stops, Netlify
// keeps the previous version live and publishes nothing.
//
// Plain Node, no packages.

const fs = require('fs');
const path = require('path');

const env = process.env;
const changed = [];

function fail(msg) {
  console.error('\nBUILD STOPPED: ' + msg + '\n');
  console.error('Nothing has been published. The previous version is still live.');
  process.exit(1);
}

function attr(v) {
  return String(v).replace(/&/g, '&amp;').replace(/"/g, '&quot;')
    .replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
function text(v) {
  return String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function read(file) {
  const p = path.join(__dirname, file);
  if (!fs.existsSync(p)) fail(file + ' is missing');
  return fs.readFileSync(p, 'utf8');
}
function write(file, s) {
  fs.writeFileSync(path.join(__dirname, file), s, 'utf8');
}

// Replace exactly one match, or stop. A pattern that finds nothing means
// the page has changed shape, and publishing it half-updated is worse
// than not publishing.
function once(s, re, fn, what, file) {
  const matches = s.match(new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g'));
  if (!matches || matches.length !== 1) {
    fail(file + ': expected exactly one ' + what + ', found ' + (matches ? matches.length : 0));
  }
  changed.push(file + ': ' + what);
  return s.replace(re, fn);
}

function setMeta(s, key, value, file) {
  const re = new RegExp('<meta\\b[^>]*\\b(?:property|name)="' + key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '"[^>]*>');
  return once(s, re, (tag) => tag.replace(/\bcontent="[^"]*"/, 'content="' + attr(value) + '"'),
    'meta ' + key, file);
}
function setTitle(s, value, file) {
  return once(s, /<title>[^<]*<\/title>/, () => '<title>' + text(value) + '</title>', '<title>', file);
}

// ---------- is there anything to do? ----------

const url = (env.SUPABASE_URL || '').trim();
const key = (env.SUPABASE_KEY || '').trim();
const title = (env.PAGE_TITLE || '').trim();

if (!url && !key && !title) {
  console.log('build.js: no site settings found, so nothing was changed.');
  process.exit(0);
}

// ---------- the database, checked hard ----------

if (!url || !key) fail('SUPABASE_URL and SUPABASE_KEY must both be set');
if (!/^https:\/\/[a-z0-9-]+\.supabase\.co\/?$/.test(url)) {
  fail('SUPABASE_URL does not look like a Supabase project address: ' + url);
}

// The key goes into a file every visitor downloads. The publishable key
// is meant for that; a secret one would hand over the whole database.
if (/^sb_secret_/.test(key)) fail('SUPABASE_KEY is a SECRET key. Use the publishable key.');
if (/^eyJ/.test(key)) {
  let claims = null;
  try {
    claims = JSON.parse(Buffer.from(key.split('.')[1], 'base64').toString('utf8'));
  } catch (e) {
    fail('SUPABASE_KEY could not be read, so it cannot be checked');
  }
  if (!claims || claims.role !== 'anon') {
    fail('SUPABASE_KEY is not the anon key (role: ' + (claims && claims.role) + '). Use the publishable key.');
  }
} else if (!/^sb_publishable_/.test(key)) {
  fail('SUPABASE_KEY does not look like a publishable key');
}

// Everything is checked before anything is written.
const site = (env.SITE_URL || '').trim().replace(/\/?$/, '/');
if (title && !/^https:\/\//.test(site)) {
  fail('SITE_URL must be set, starting https://, for the preview image');
}

// ---------- config.js ----------

let cfg = read('config.js');
cfg = once(cfg, /SUPABASE_URL:\s*"[^"]*"/, () => 'SUPABASE_URL: "' + url.replace(/\/$/, '') + '"',
  'SUPABASE_URL', 'config.js');
cfg = once(cfg, /SUPABASE_ANON_KEY:\s*"[^"]*"/, () => 'SUPABASE_ANON_KEY: "' + key + '"',
  'SUPABASE_ANON_KEY', 'config.js');
if (env.APPROVER) {
  cfg = once(cfg, /APPROVER:\s*"[^"]*"/, () => 'APPROVER: ' + JSON.stringify(env.APPROVER.trim()),
    'APPROVER', 'config.js');
}
if (env.CONTACT) {
  cfg = once(cfg, /CONTACT:\s*"[^"]*"/, () => 'CONTACT: ' + JSON.stringify(env.CONTACT.trim()),
    'CONTACT', 'config.js');
}
cfg = '// Written for this site by build.js at deploy time.\n' + cfg;
write('config.js', cfg);

// ---------- link previews and names ----------

if (title) {
  const image = site + 'preview.png';
  const desc = (env.PAGE_DESCRIPTION || '').trim();

  let idx = read('index.html');
  idx = setTitle(idx, title, 'index.html');
  idx = setMeta(idx, 'og:title', title, 'index.html');
  idx = setMeta(idx, 'og:site_name', title, 'index.html');
  idx = setMeta(idx, 'twitter:title', title, 'index.html');
  idx = setMeta(idx, 'og:image', image, 'index.html');
  idx = setMeta(idx, 'twitter:image', image, 'index.html');
  idx = setMeta(idx, 'apple-mobile-web-app-title', title, 'index.html');
  if (desc) {
    idx = setMeta(idx, 'og:description', desc, 'index.html');
    idx = setMeta(idx, 'twitter:description', desc, 'index.html');
  }
  idx = once(idx, /<h1 id="h1">[^<]*<\/h1>/, () => '<h1 id="h1">' + text(title) + '</h1>',
    'the page heading', 'index.html');
  write('index.html', idx);

  let jr = read('journal.html');
  jr = setMeta(jr, 'apple-mobile-web-app-title', title, 'journal.html');
  const jt = (env.JOURNAL_TITLE || '').trim();
  if (jt) {
    jr = setTitle(jr, jt, 'journal.html');
    jr = once(jr, /<h1>[^<]*<\/h1>/, () => '<h1>' + text(jt) + '</h1>', 'the journal heading', 'journal.html');
  }
  write('journal.html', jr);

  let mn = read('mine.html');
  mn = setMeta(mn, 'apple-mobile-web-app-title', title, 'mine.html');
  write('mine.html', mn);
}

// ---------- say what happened ----------

console.log('build.js: this site talks to ' + url);
console.log('build.js: key ' + key.slice(0, 16) + '…');
changed.forEach(c => console.log('  changed ' + c));
