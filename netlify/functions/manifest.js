// The web app manifest, which Android reads when someone adds the page
// to their home screen. Served from a function so it needs no separate
// file in the repository.
//
// iOS ignores this and uses the meta tags in the pages instead, which is
// why both exist.

export default async () => {
  const site = (process.env.SITE_URL || '').replace(/\/+$/, '');

  return new Response(JSON.stringify({
    name: 'For Tracey',
    short_name: 'For Tracey',
    description: 'What Tracey needs, and who is covering it.',
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
