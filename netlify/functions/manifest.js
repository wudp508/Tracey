// The web app manifest, which Android reads when someone adds the page
// to their home screen. Served from a function so it needs no separate
// file in the repository.
//
// iOS ignores this and uses the meta tags in the pages instead, which is
// why both exist.

// ---------- the words, from settings ----------
//
// Who the page is for and what it is called, so a clone's emails read as
// its own. Read once and kept for a minute: a change in Settings reaches
// the next emails quickly, without a database call for every message.
//
// The same rule as the pages: a sentence's subject is the name, so
// "they" never needs a verb to change; pronouns only appear as
// her/his/their and her/him/them.
let WORDS = null, WORDS_AT = 0;
async function wording() {
  if (WORDS && Date.now() - WORDS_AT < 60000) return WORDS;
  const { SUPABASE_URL, SUPABASE_KEY } = process.env;
  let s = {};
  if (SUPABASE_URL && SUPABASE_KEY) {
    try {
      const r = await fetch(`${SUPABASE_URL}/rest/v1/rpc/public_settings`, {
        method: 'POST',
        // Never let the wording hold anything up. The health check runs
        // this first, and a check that hangs is worse than one that fails.
        signal: AbortSignal.timeout ? AbortSignal.timeout(3000) : undefined,
        headers: { 'Content-Type': 'application/json', 'apikey': SUPABASE_KEY,
                   'Authorization': `Bearer ${SUPABASE_KEY}` },
        body: '{}'
      });
      if (r.ok) s = JSON.parse(await r.text()) || {};
    } catch (e) { /* the defaults below are a perfectly good email */ }
  }
  const pick = (k, d) => (s[k] && String(s[k]).trim()) || d;
  const name = pick('person_name', 'Tracey');
  const p = pick('pronoun', 'she');
  WORDS = {
    name,
    title: pick('page_title', 'For ' + name),
    journal: pick('journal_title', name + '\u2019s journey'),
    her: p === 'he' ? 'his' : p === 'they' ? 'their' : 'her',
    obj: p === 'he' ? 'him' : p === 'they' ? 'them' : 'her'
  };
  WORDS_AT = Date.now();
  return WORDS;
}

export default async () => {
  const W = await wording();
  const site = (process.env.SITE_URL || '').replace(/\/+$/, '');

  return new Response(JSON.stringify({
    name: W.title,
    short_name: W.title,
    description: 'What ' + W.name + ' needs, and who is covering it.',
    start_url: '/',
    display: 'standalone',
    background_color: '#F7F5F0',
    theme_color: '#F7F5F0',
    icons: [
      { src: '/icon-192.png', sizes: '192x192', type: 'image/png' },
      { src: '/icon-512.png', sizes: '512x512', type: 'image/png' },
      { src: '/icon-180.png', sizes: '180x180', type: 'image/png' }
    ]
  }, null, 2), {
    status: 200,
    headers: {
      'Content-Type': 'application/manifest+json',
      'Cache-Control': 'public, max-age=3600'
    }
  });
};

export const config = { path: '/manifest.json' };
