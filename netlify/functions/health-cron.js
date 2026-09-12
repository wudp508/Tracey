// Calls the health check on a schedule.
//
// Netlify allows a function to have a path or a schedule, but not both,
// and a scheduled function cannot be reached by URL. Keeping the checks
// in health.js means you can still run them on demand at /api/health;
// this file exists only to call that once a day.
//
// 15:00 UTC is 8am Pacific in summer, 7am in winter — early enough that
// a problem is known before the day's needs matter.

export default async () => {
  const base = (process.env.SITE_URL || '').replace(/\/+$/, '');
  if (!base) {
    console.error('SITE_URL is not set, so the health check cannot be called');
    return;
  }

  try {
    const res = await fetch(base + '/api/health');
    const text = await res.text();
    console.log('Health check ran:', res.status, text.slice(0, 400));
  } catch (e) {
    // The check emails on its own when it finds problems. If it cannot be
    // reached at all, that is itself worth knowing, so say so loudly here.
    console.error('Could not reach the health check:', e);
  }
};

export const config = { schedule: '0 15 * * *' };
