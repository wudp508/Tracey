// Tells a running page which deploy it is talking to.
//
// A page that has been open since before an update keeps running the
// code it was loaded with. There is no way for a new deploy to reach
// back into it — so instead the page asks, periodically, whether it is
// still current, and reloads itself when it is not.
//
// Netlify sets COMMIT_REF at build time. Falling back to a fixed string
// is deliberate: if the value is unavailable the check simply never
// fires, rather than reloading the page every three minutes.

const BUILD = process.env.COMMIT_REF
  || process.env.DEPLOY_ID
  || 'unknown';

export default async () => {
  return new Response(JSON.stringify({ build: BUILD }), {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
      // Must never be cached, or a stale answer would either hide an
      // update or cause a reload loop.
      'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0',
      'Netlify-CDN-Cache-Control': 'no-store'
    }
  });
};

export const config = { path: '/api/version' };
