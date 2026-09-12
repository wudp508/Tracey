// Sends an email to the coordinators when a friend claims or releases a
// need. The page tells us which need changed; we look the details up
// ourselves so nothing sensitive travels from the browser.
//
// Environment variables required (set in Netlify):
//   SUPABASE_URL, SUPABASE_KEY, INGEST_TOKEN   (already set)
//   BREVO_API_KEY   from Brevo, SMTP & API -> API Keys
//   NOTIFY_FROM     your verified Brevo sender address
//   NOTIFY_TO       who to tell, comma separated
//   SITE_URL        optional, e.g. https://tracey-humphreys-help-her-recover.netlify.app

function fmtDate(iso) {
  if (!iso) return '';
  try {
    return new Date(iso + 'T00:00:00').toLocaleDateString('en-US', {
      weekday: 'long', month: 'long', day: 'numeric'
    });
  } catch (e) { return iso; }
}

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export default async (request) => {
  // A GET shows what is configured, so problems can be diagnosed from a
  // browser. Reports only whether each value is present, never the value.
  if (request.method === 'GET') {
    const report = {
      SUPABASE_URL:  !!process.env.SUPABASE_URL,
      SUPABASE_KEY:  !!process.env.SUPABASE_KEY,
      INGEST_TOKEN:  !!process.env.INGEST_TOKEN,
      BREVO_API_KEY: !!process.env.BREVO_API_KEY,
      NOTIFY_FROM:   process.env.NOTIFY_FROM || null,
      NOTIFY_TO:     process.env.NOTIFY_TO || null,
      SITE_URL:      process.env.SITE_URL || null
    };

    // Also check we can reach the database function this relies on.
    let dbCheck = 'not attempted';
    if (process.env.SUPABASE_URL && process.env.SUPABASE_KEY && process.env.INGEST_TOKEN) {
      try {
        const r = await fetch(`${process.env.SUPABASE_URL}/rest/v1/rpc/need_summary`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'apikey': process.env.SUPABASE_KEY,
            'Authorization': `Bearer ${process.env.SUPABASE_KEY}`
          },
          body: JSON.stringify({
            p_token: process.env.INGEST_TOKEN,
            p_id: '00000000-0000-0000-0000-000000000000'
          })
        });
        const txt = await r.text();
        dbCheck = r.ok
          ? 'reachable (returned ' + txt.slice(0, 40) + ')'
          : 'error ' + r.status + ': ' + txt.slice(0, 200);
      } catch (e) {
        dbCheck = 'unreachable: ' + String(e).slice(0, 200);
      }
    }
    report.database = dbCheck;

    // Adding ?send=1 actually sends a test email, so the whole path can
    // be checked from a browser without claiming anything.
    const url = new URL(request.url);
    if (url.searchParams.get('send') === '1') {
      try {
        const res = await fetch('https://api.brevo.com/v3/smtp/email', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'accept': 'application/json',
            'api-key': process.env.BREVO_API_KEY
          },
          body: JSON.stringify({
            sender: { email: process.env.NOTIFY_FROM, name: 'For Tracey' },
            to: (process.env.NOTIFY_TO || '').split(',')
                  .map(e => e.trim()).filter(Boolean).map(e => ({ email: e })),
            subject: 'Test from the Tracey signup page',
            htmlContent: '<p>If you are reading this, notifications are working.</p>',
            textContent: 'If you are reading this, notifications are working.'
          })
        });
        const out = await res.text();
        report.testSend = res.ok
          ? 'sent ok: ' + out.slice(0, 120)
          : 'FAILED ' + res.status + ': ' + out.slice(0, 400);
      } catch (e) {
        report.testSend = 'threw: ' + String(e).slice(0, 300);
      }
    }

    return new Response(JSON.stringify(report, null, 2), {
      status: 200, headers: { 'Content-Type': 'application/json' }
    });
  }

  if (request.method !== 'POST') {
    return new Response('Method not allowed', { status: 405 });
  }

  const {
    SUPABASE_URL, SUPABASE_KEY, INGEST_TOKEN,
    BREVO_API_KEY, NOTIFY_FROM, NOTIFY_TO, SITE_URL
  } = process.env;

  if (!BREVO_API_KEY || !NOTIFY_FROM || !NOTIFY_TO) {
    console.error('Notification env vars missing');
    return new Response('Not configured', { status: 500 });
  }

  let body;
  try { body = await request.json(); }
  catch (e) { return new Response('Bad request', { status: 400 }); }

  const id = body && body.id;
  const action = body && body.action;
  if (!id || (action !== 'claimed' && action !== 'released')) {
    return new Response('Bad request', { status: 400 });
  }

  // Look the need up ourselves rather than trusting the caller.
  let need;
  try {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/need_summary`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': SUPABASE_KEY,
        'Authorization': `Bearer ${SUPABASE_KEY}`
      },
      body: JSON.stringify({ p_token: INGEST_TOKEN, p_id: id })
    });
    if (!res.ok) {
      console.error('Could not read need', res.status, await res.text());
      return new Response('Upstream error', { status: 502 });
    }
    need = await res.json();
  } catch (e) {
    console.error('Supabase unreachable', e);
    return new Response('Upstream unreachable', { status: 502 });
  }

  if (!need) return new Response('Unknown need', { status: 404 });

  const when = `${fmtDate(need.date)}, ${need.start_time}${need.end_time ? '–' + need.end_time : ''}`;
  const site = SITE_URL || '';

  let subject, heading, lines;

  if (action === 'claimed') {
    subject = `${need.volunteer || 'Someone'} signed up: ${need.title}`;
    heading = `${need.volunteer || 'Someone'} is covering this`;
    lines = [
      `<strong>${esc(need.title)}</strong>`,
      esc(when),
      need.location ? esc(need.location) : '',
      '',
      `Volunteer: <strong>${esc(need.volunteer || '')}</strong>`,
      need.email ? `Email: ${esc(need.email)}` : '',
      '',
      `<em>Next step: add them to the Outlook event and send the update.</em>`
    ];
  } else {
    subject = `Slot freed up: ${need.title}`;
    heading = 'This is open again';
    lines = [
      `<strong>${esc(need.title)}</strong>`,
      esc(when),
      need.location ? esc(need.location) : '',
      '',
      `Someone who had signed up can no longer make it, so this is back`,
      `on the list for another friend to take.`,
      '',
      need.invited
        ? `<strong>They were already on the Outlook invite — remove them from the event.</strong>`
        : `<em>No Outlook invite had gone out yet, so there is nothing to undo.</em>`,
      '',
      `${need.open_count} need${need.open_count === 1 ? '' : 's'} open right now.`
    ];
  }

  const html = `
    <div style="font-family:-apple-system,Segoe UI,sans-serif;font-size:15px;
                line-height:1.55;color:#2B2321;max-width:480px">
      <p style="font-size:17px;font-weight:600;margin:0 0 14px">${esc(heading)}</p>
      <p style="margin:0 0 14px">${lines.filter(l => l !== '').join('<br>')}</p>
      ${site ? `<p style="margin:18px 0 0"><a href="${site}" style="color:#3D5A5B">Open the signup page</a></p>` : ''}
    </div>`;

  const text = [heading, '', ...lines]
    .join('\n').replace(/<[^>]+>/g, '');

  const recipients = NOTIFY_TO.split(',')
    .map(e => e.trim()).filter(Boolean).map(e => ({ email: e }));

  try {
    const res = await fetch('https://api.brevo.com/v3/smtp/email', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'accept': 'application/json',
        'api-key': BREVO_API_KEY
      },
      body: JSON.stringify({
        sender: { email: NOTIFY_FROM, name: 'For Tracey' },
        to: recipients,
        subject: subject,
        htmlContent: html,
        textContent: text
      })
    });
    const out = await res.text();
    if (!res.ok) {
      console.error('Brevo rejected the send:', res.status, out);
      return new Response(JSON.stringify({ error: 'brevo rejected', status: res.status, detail: out.slice(0, 300) }), {
        status: 502, headers: { 'Content-Type': 'application/json' }
      });
    }
    console.log('Notified', action, need.title);
    return new Response(JSON.stringify({ sent: true }), {
      status: 200, headers: { 'Content-Type': 'application/json' }
    });
  } catch (e) {
    console.error('Brevo unreachable', e);
    return new Response('Send failed', { status: 502 });
  }
};

export const config = { path: '/api/notify' };
