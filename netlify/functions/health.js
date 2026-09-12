// Runs once a day and checks the system is actually working.
//
// Emails only when something is wrong. A monitor that writes to you
// every morning stops being read by the second week, and then it is
// worse than nothing.
//
// Visit /api/health in a browser to run it on demand and see the full
// report whether or not there are problems.
//
// Environment variables: the ones the other functions already use.

const CHECKS = [];

function record(name, ok, detail) {
  CHECKS.push({ name, ok, detail: detail || '' });
}

// Confirms an endpoint exists and is running our code. A GET to the
// inbound functions should be refused by them, not 404ed by Netlify.
async function checkEndpoint(base, path, expected) {
  try {
    const res = await fetch(base + path, { method: 'GET' });
    const ok = expected.includes(res.status);
    record(path, ok, ok ? '' : 'returned ' + res.status);
  } catch (e) {
    record(path, false, 'unreachable: ' + String(e && e.message ? e.message : e).slice(0, 120));
  }
}

export default async () => {
  CHECKS.length = 0;

  const {
    SUPABASE_URL, SUPABASE_KEY, INGEST_TOKEN,
    BREVO_API_KEY, NOTIFY_FROM, NOTIFY_TO, SITE_URL,
    SMTP_LOGIN, SMTP_KEY, TIMEZONE
  } = process.env;

  // ---------- configuration ----------
  const required = { SUPABASE_URL, SUPABASE_KEY, INGEST_TOKEN,
                     BREVO_API_KEY, NOTIFY_FROM, NOTIFY_TO,
                     SMTP_LOGIN, SMTP_KEY, TIMEZONE };
  const missing = Object.keys(required).filter(k => !required[k]);
  record('environment variables', missing.length === 0,
         missing.length ? 'missing: ' + missing.join(', ') : '');

  // ---------- the database, and the write path that failed before ----------
  let report = null;
  if (SUPABASE_URL && SUPABASE_KEY && INGEST_TOKEN) {
    try {
      const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/health_check`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'apikey': SUPABASE_KEY,
          'Authorization': `Bearer ${SUPABASE_KEY}`
        },
        body: JSON.stringify({ p_token: INGEST_TOKEN })
      });
      const text = await res.text();
      if (!res.ok) {
        record('database', false, res.status + ': ' + text.slice(0, 200));
      } else {
        report = JSON.parse(text);
        record('database', true);
        record('calendar write path', report.ok === true || !(report.problems || []).some(
          p => /canary/i.test(p)), (report.problems || []).filter(p => /canary/i.test(p)).join('; '));
        (report.problems || []).filter(p => !/canary/i.test(p))
          .forEach(p => record('needs attention', false, p));
      }
    } catch (e) {
      record('database', false, 'unreachable: ' + String(e && e.message ? e.message : e).slice(0, 150));
    }
  }

  // ---------- the endpoints the mail relay posts to ----------
  const base = (SITE_URL || '').replace(/\/+$/, '');
  if (base) {
    // 405 is our own "method not allowed", which proves the function ran.
    await checkEndpoint(base, '/api/inbound-calendar', [405]);
    await checkEndpoint(base, '/api/inbound-post', [405]);
    await checkEndpoint(base, '/api/notify', [200]);
    await checkEndpoint(base, '/', [200]);
    await checkEndpoint(base, '/journal', [200]);
    await checkEndpoint(base, '/preview.png', [200]);
  } else {
    record('site checks', false, 'SITE_URL not set, so pages were not checked');
  }

  const failures = CHECKS.filter(c => !c.ok);
  const healthy = failures.length === 0;

  // ---------- tell someone, but only when it matters ----------
  if (!healthy && BREVO_API_KEY && NOTIFY_FROM && NOTIFY_TO) {
    const rows = failures.map(f =>
      `<li><strong>${f.name}</strong>${f.detail ? ' \u2014 ' + f.detail : ''}</li>`).join('');
    const html = `
      <div style="font-family:-apple-system,Segoe UI,sans-serif;font-size:15px;
                  line-height:1.55;color:#2B2321;max-width:520px">
        <p style="font-size:17px;font-weight:600;margin:0 0 14px">
          The signup page needs a look</p>
        <ul style="margin:0 0 16px;padding-left:20px">${rows}</ul>
        <p style="margin:0 0 14px;color:#6E6558;font-size:13px">
          Everything else checked out. This runs once a day and only writes
          when something is wrong.</p>
        ${base ? `<p style="margin:16px 0 0"><a href="${base}" style="color:#3D5A5B">Open the signup page</a></p>` : ''}
      </div>`;

    try {
      await fetch('https://api.brevo.com/v3/smtp/email', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'accept': 'application/json',
          'api-key': BREVO_API_KEY
        },
        body: JSON.stringify({
          sender: { email: NOTIFY_FROM, name: 'For Tracey' },
          to: NOTIFY_TO.split(',').map(e => e.trim()).filter(Boolean).map(e => ({ email: e })),
          subject: `For Tracey: ${failures.length} thing${failures.length === 1 ? '' : 's'} to look at`,
          htmlContent: html,
          textContent: failures.map(f => `- ${f.name}${f.detail ? ': ' + f.detail : ''}`).join('\n')
        })
      });
    } catch (e) {
      console.error('Could not send the health email', e);
    }
  }

  console.log(healthy ? 'Health check passed' : 'Health check found problems',
              JSON.stringify(failures));

  return new Response(JSON.stringify({
    healthy: healthy,
    checks: CHECKS,
    summary: report ? {
      open_needs: report.open_needs,
      claimed_tomorrow: report.claimed_tomorrow,
      posts: report.posts
    } : null
  }, null, 2), {
    status: 200,
    headers: { 'Content-Type': 'application/json' }
  });
};

// Netlify allows a function to have a path or a schedule, never both, and
// a scheduled function cannot be reached by URL. So this one answers at a
// URL, and health-cron.js calls it on a schedule.
export const config = { path: '/api/health' };
