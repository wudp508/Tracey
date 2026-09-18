// Calls the evening reminders on a schedule.
//
// As with the health check, Netlify allows a function to have a path or
// a schedule but not both, so the work lives in reminders.js and this
// file only calls it. That also means reminders can be run on demand at
// /api/reminders for testing.
//
// 01:00 UTC is 6pm Pacific in summer, 5pm in winter. Late enough that
// most people have finished the day, early enough to rearrange an
// evening or say something has come up.


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
  await heartbeat('reminders');

  const base = (process.env.SITE_URL || '').replace(/\/+$/, '');
  if (!base) {
    console.error('SITE_URL is not set, so reminders cannot be sent');
    return;
  }

  try {
    const res = await fetch(base + '/api/reminders');
    console.log('Reminders ran:', res.status, (await res.text()).slice(0, 300));
  } catch (e) {
    console.error('Could not reach the reminder job:', e);
  }

  // Also run the health check. If the health schedule has quietly died,
  // this is what still notices — and the health check only emails when
  // something is wrong, so running it twice a day costs nothing.
  try {
    const h = await fetch(base + '/api/health');
    console.log('Health check from the evening job:', h.status);
  } catch (e) {
    console.error('Could not reach the health check:', e);
  }
};

export const config = { schedule: '0 1 * * *' };
