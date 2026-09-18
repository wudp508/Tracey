// Calls the health check on a schedule.
//
// Netlify allows a function to have a path or a schedule, but not both,
// and a scheduled function cannot be reached by URL. Keeping the checks
// in health.js means you can still run them on demand at /api/health;
// this file exists only to call that once a day.
//
// 15:00 UTC is 8am Pacific in summer, 7am in winter — early enough that
// a problem is known before the day's needs matter.


// Records that this job ran. The point is not the log entry but the
// absence of one: a scheduled function that has silently stopped is
// otherwise indistinguishable from one with nothing to do.
async function heartbeat(which) {
  const { SUPABASE_URL, SUPABASE_KEY, INGEST_TOKEN } = process.env;
  if (!SUPABASE_URL || !SUPABASE_KEY || !INGEST_TOKEN) return;
  try {
    await fetch(`${SUPABASE_URL}/rest/v1/rpc/heartbeat`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': SUPABASE_KEY,
        'Authorization': `Bearer ${SUPABASE_KEY}`
      },
      body: JSON.stringify({ p_token: INGEST_TOKEN, p_which: which })
    });
  } catch (e) {
    console.error('Could not record the run', e);
  }
}

export default async () => {
  await heartbeat('health');

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
