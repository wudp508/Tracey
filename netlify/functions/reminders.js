// Evening reminders for tomorrow.
//
// Calendar apps alert people on the day. This is the nudge the night
// before — enough warning to rearrange an evening, or to say so if
// something has come up.
//
// Volunteers get one email each, listing everything they are covering
// tomorrow. Coordinators get one summary, which names anything still
// uncovered so there is an evening left to ask someone.
//
// Runs at /api/reminders so it can be tested on demand; reminders-cron.js
// calls it at 6pm Pacific.

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"]/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

function fmtDate(iso) {
  try {
    return new Date(iso + 'T12:00:00Z').toLocaleDateString('en-US',
      { weekday: 'long', month: 'long', day: 'numeric', timeZone: 'UTC' });
  } catch (e) { return iso; }
}

function when(n) {
  return n.start_time + (n.end_time ? '\u2013' + n.end_time : '');
}

async function sendMail(key, from, to, subject, html, text) {
  const res = await fetch('https://api.brevo.com/v3/smtp/email', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'accept': 'application/json',
      'api-key': key
    },
    body: JSON.stringify({
      sender: { email: from, name: 'For Tracey' },
      to: to,
      replyTo: { email: from },
      subject: subject,
      htmlContent: html,
      textContent: text
    })
  });
  if (!res.ok) {
    console.error('Send failed:', res.status, await res.text());
    return false;
  }
  return true;
}

export default async (request) => {
  // The health check pings this endpoint daily. Without a way to look
  // without sending, that ping would email every volunteer every
  // afternoon. ?dry=1 reports what would go out and sends nothing.
  let dryRun = false;
  try {
    dryRun = new URL(request.url).searchParams.get('dry') === '1';
  } catch (e) { /* called without a URL: send for real */ }

  const {
    SUPABASE_URL, SUPABASE_KEY, INGEST_TOKEN,
    BREVO_API_KEY, NOTIFY_FROM, NOTIFY_TO, SITE_URL
  } = process.env;

  if (!SUPABASE_URL || !SUPABASE_KEY || !INGEST_TOKEN || !BREVO_API_KEY || !NOTIFY_FROM) {
    console.error('Missing environment variables');
    return new Response('Server not configured', { status: 500 });
  }

  // ---------- what tomorrow holds ----------
  let brief;
  try {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/tomorrow_brief`, {
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
      console.error('Could not read tomorrow:', res.status, text);
      return new Response('Upstream error', { status: 502 });
    }
    brief = JSON.parse(text);
  } catch (e) {
    console.error('Supabase unreachable', e);
    return new Response('Upstream unreachable', { status: 502 });
  }

  const claimed = brief.claimed || [];
  const open = brief.open || [];
  const dayName = fmtDate(brief.date);

  // Nothing at all tomorrow: say nothing. An empty reminder is the
  // fastest way to teach someone to ignore these.
  if (!claimed.length && !open.length) {
    console.log('Nothing tomorrow, no email sent');
    return new Response(JSON.stringify({ sent: 0, dry_run: dryRun,
                                         reason: 'nothing tomorrow' }), {
      status: 200, headers: { 'Content-Type': 'application/json' }
    });
  }

  // ---------- one email per volunteer ----------
  const byPerson = {};
  claimed.forEach(n => {
    const key = String(n.volunteer_email).toLowerCase();
    if (!byPerson[key]) byPerson[key] = { name: n.volunteer_name, items: [] };
    byPerson[key].items.push(n);
  });

  let sentCount = 0;
  const failures = [];

  for (const email of Object.keys(byPerson)) {
    const person = byPerson[email];
    const first = (person.name || '').trim().split(/\s+/)[0] || 'there';
    const items = person.items;

    const rows = items.map(n =>
      `<li style="margin-bottom:10px">
         <strong>${esc(n.title)}</strong><br>
         ${esc(when(n))}${n.location ? '<br>' + esc(n.location) : ''}
         ${n.instructions ? `<br><span style="color:#6E6558">${esc(n.instructions)}</span>` : ''}
       </li>`).join('');

    const html = `
      <div style="font-family:-apple-system,Segoe UI,sans-serif;font-size:15px;
                  line-height:1.55;color:#2B2321;max-width:480px">
        <p style="font-size:17px;font-weight:600;margin:0 0 14px">
          ${esc(first)}, a reminder about tomorrow</p>
        <p style="margin:0 0 14px">You are covering
          ${items.length === 1 ? 'this' : 'these'} on ${esc(dayName)}:</p>
        <ul style="margin:0 0 16px;padding-left:20px">${rows}</ul>
        <p style="margin:0 0 14px;color:#6E6558;font-size:13.5px">
          If something has come up, open the page and free it up \u2014 that gives
          someone else the evening to pick it up.</p>
        ${SITE_URL ? `<p style="margin:18px 0 0"><a href="${SITE_URL}" style="color:#3D5A5B">Open the signup page</a></p>` : ''}
      </div>`;

    const text = `${first}, a reminder about tomorrow.\n\n`
      + `You are covering ${items.length === 1 ? 'this' : 'these'} on ${dayName}:\n\n`
      + items.map(n => `- ${n.title}\n  ${when(n)}${n.location ? '\n  ' + n.location : ''}`).join('\n\n')
      + `\n\nIf something has come up, open the page and free it up.`;

    if (dryRun) { sentCount++; continue; }

    const ok = await sendMail(
      BREVO_API_KEY, NOTIFY_FROM,
      [{ email: email, name: person.name || undefined }],
      items.length === 1
        ? `Tomorrow: ${items[0].title}`
        : `Tomorrow: ${items.length} things`,
      html, text);

    if (ok) sentCount++; else failures.push(email);
  }

  // ---------- one summary for the coordinators ----------
  if (NOTIFY_TO && !dryRun) {
    const coveredRows = claimed.length
      ? claimed.map(n =>
          `<li style="margin-bottom:7px"><strong>${esc(n.title)}</strong> \u00b7 ${esc(when(n))}<br>
           <span style="color:#6E6558">${esc(n.volunteer_name || n.volunteer_email)}${n.invited ? '' : ' \u2014 no Outlook invite sent'}</span></li>`
        ).join('')
      : '';

    const openRows = open.length
      ? open.map(n =>
          `<li style="margin-bottom:7px"><strong>${esc(n.title)}</strong> \u00b7 ${esc(when(n))}${n.location ? '<br><span style="color:#6E6558">' + esc(n.location) + '</span>' : ''}</li>`
        ).join('')
      : '';

    const html = `
      <div style="font-family:-apple-system,Segoe UI,sans-serif;font-size:15px;
                  line-height:1.55;color:#2B2321;max-width:500px">
        <p style="font-size:17px;font-weight:600;margin:0 0 14px">Tomorrow \u2014 ${esc(dayName)}</p>
        ${open.length ? `
          <p style="margin:0 0 8px;font-weight:600;color:#B5696A">
            Still uncovered (${open.length})</p>
          <ul style="margin:0 0 18px;padding-left:20px">${openRows}</ul>
          <p style="margin:0 0 18px;font-size:13.5px;color:#6E6558">
            There is still an evening to ask someone directly.</p>` : `
          <p style="margin:0 0 18px;color:#6B7F5E;font-weight:600">
            Everything tomorrow is covered.</p>`}
        ${claimed.length ? `
          <p style="margin:0 0 8px;font-weight:600">Covered (${claimed.length})</p>
          <ul style="margin:0 0 16px;padding-left:20px">${coveredRows}</ul>
          <p style="margin:0 0 14px;font-size:13.5px;color:#6E6558">
            ${sentCount} reminder${sentCount === 1 ? '' : 's'} sent.
            ${failures.length ? 'Could not reach: ' + esc(failures.join(', ')) + '.' : ''}</p>` : ''}
        ${SITE_URL ? `<p style="margin:18px 0 0"><a href="${SITE_URL}" style="color:#3D5A5B">Open the signup page</a></p>` : ''}
      </div>`;

    const text = `Tomorrow — ${dayName}\n\n`
      + (open.length
          ? `STILL UNCOVERED (${open.length}):\n`
            + open.map(n => `- ${n.title} · ${when(n)}`).join('\n') + '\n\n'
          : 'Everything tomorrow is covered.\n\n')
      + (claimed.length
          ? `COVERED (${claimed.length}):\n`
            + claimed.map(n => `- ${n.title} · ${when(n)} · ${n.volunteer_name || n.volunteer_email}`).join('\n')
          : '');

    await sendMail(
      BREVO_API_KEY, NOTIFY_FROM,
      NOTIFY_TO.split(',').map(e => e.trim()).filter(Boolean).map(e => ({ email: e })),
      open.length
        ? `Tomorrow: ${open.length} still uncovered`
        : `Tomorrow: all ${claimed.length} covered`,
      html, text);
  }

  console.log(`Reminders${dryRun ? ' (dry run)' : ''}: ${sentCount}, ${open.length} uncovered`);

  return new Response(JSON.stringify({
    date: brief.date,
    dry_run: dryRun,
    reminders_sent: sentCount,
    failed: failures,
    covered: claimed.length,
    uncovered: open.length
  }, null, 2), {
    status: 200, headers: { 'Content-Type': 'application/json' }
  });
};

export const config = { path: '/api/reminders' };
