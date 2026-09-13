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

export default async () => {
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
};

export const config = { schedule: '0 1 * * *' };
