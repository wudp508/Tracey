// One email to every registered friend, listing what is still open.
//
// The recipient list is built in the database from the coordinator
// passphrase, never sent from the browser — otherwise anyone who found
// this endpoint could mail the whole circle.
//
// Sent as individual messages rather than one with everyone in the To
// field, so nobody sees anybody else's address.

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

export default async (request) => {
  if (request.method !== 'POST') {
    return new Response('Method not allowed', { status: 405 });
  }

  const { SUPABASE_URL, SUPABASE_KEY, BREVO_API_KEY, NOTIFY_FROM, SITE_URL }
    = process.env;
  if (!SUPABASE_URL || !SUPABASE_KEY || !BREVO_API_KEY || !NOTIFY_FROM) {
    return new Response('Server not configured', { status: 500 });
  }

  let body;
  try { body = await request.json(); }
  catch (e) { return new Response('Bad request', { status: 400 }); }

  const pass = body && body.pass;
  const note = (body && body.note ? String(body.note) : '').trim();
  const dryRun = body && body.dry === true;
  if (!pass) return new Response('Bad request', { status: 400 });

  // ---------- who, and what ----------
  let data;
  try {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/broadcast_list`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': SUPABASE_KEY,
        'Authorization': `Bearer ${SUPABASE_KEY}`
      },
      body: JSON.stringify({ p_pass: pass })
    });
    if (!res.ok) {
      // A bad passphrase looks the same as any other rejection here.
      return new Response(JSON.stringify({ error: 'not allowed' }), {
        status: 403, headers: { 'Content-Type': 'application/json' }
      });
    }
    data = JSON.parse(await res.text());
  } catch (e) {
    console.error('Supabase unreachable', e);
    return new Response('Upstream unreachable', { status: 502 });
  }

  const people = data.recipients || [];
  const open = data.open || [];
  const site = (SITE_URL || '').replace(/\/+$/, '');

  if (!open.length) {
    return new Response(JSON.stringify({
      sent: 0, reason: 'nothing is open, so there is nothing to ask for'
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }
  if (!people.length) {
    return new Response(JSON.stringify({ sent: 0, reason: 'nobody registered' }), {
      status: 200, headers: { 'Content-Type': 'application/json' }
    });
  }

  if (dryRun) {
    return new Response(JSON.stringify({
      dry_run: true, would_send_to: people.length, open_needs: open.length,
      last_sent: data.last_sent || null
    }, null, 2), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }

  // ---------- the list, grouped by day so it reads like a week ----------
  const byDay = {};
  open.forEach(n => { (byDay[n.date] = byDay[n.date] || []).push(n); });

  const dayBlocks = Object.keys(byDay).sort().map(d => {
    const rows = byDay[d].map(n =>
      `<li style="margin-bottom:7px">
         <strong>${esc(n.title)}</strong> &middot; ${esc(n.start_time)}
         ${n.location ? '<br><span style="color:#6E6558">' + esc(n.location) + '</span>' : ''}
         ${n.other_half_covered
            ? '<br><span style="color:#A85C32">The other half of this trip is covered</span>'
            : ''}
       </li>`).join('');
    return `<p style="margin:16px 0 6px;font-weight:600;font-size:13px;
              text-transform:uppercase;letter-spacing:.05em;color:#6E6558">
              ${esc(fmtDate(d))}</p>
            <ul style="margin:0;padding-left:20px">${rows}</ul>`;
  }).join('');

  const textList = Object.keys(byDay).sort().map(d =>
    fmtDate(d) + '\n' + byDay[d].map(n =>
      `  - ${n.title} · ${n.start_time}${n.location ? ' · ' + n.location : ''}`
    ).join('\n')).join('\n\n');

  // ---------- send, one at a time ----------
  let sent = 0;
  const failed = [];

  for (const p of people) {
    const first = String(p.name || '').trim().split(/\s+/)[0] || 'there';

    const html = `
      <div style="font-family:-apple-system,Segoe UI,sans-serif;font-size:15px;
                  line-height:1.6;color:#2B2321;max-width:480px">
        <p style="font-size:17px;font-weight:600;margin:0 0 14px">
          ${esc(first)}, a few things are still open</p>
        ${note ? `<p style="margin:0 0 14px">${esc(note)}</p>` : ''}
        <p style="margin:0 0 4px">Here is what nobody has picked up yet. Take
          whatever fits your week &mdash; one tap and it is yours, and the
          calendar invitation comes to you.</p>
        ${dayBlocks}
        <p style="margin:22px 0 0">
          <a href="${site}" style="color:#3D5A5B;font-weight:600">Open the signup page</a></p>
        <p style="margin:16px 0 0;color:#6E6558;font-size:13px">
          No pressure at all &mdash; if this week is not one where you can,
          that is completely fine.</p>
      </div>`;

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
          to: [{ email: p.email, name: p.name || undefined }],
          replyTo: { email: NOTIFY_FROM },
          subject: open.length === 1
            ? 'One thing still needs someone'
            : `${open.length} things still need someone`,
          htmlContent: html,
          textContent: `${first}, a few things are still open.\n\n`
            + (note ? note + '\n\n' : '')
            + textList + `\n\n${site}\n\n`
            + `No pressure at all — if this week is not one where you can, `
            + `that is completely fine.`
        })
      });
      if (res.ok) sent++;
      else { failed.push(p.email); console.error('Send failed for', p.email, res.status); }
    } catch (e) {
      failed.push(p.email);
      console.error('Send threw for', p.email, e);
    }
  }

  // Record it so the panel can say when this last went out.
  try {
    await fetch(`${SUPABASE_URL}/rest/v1/rpc/record_broadcast`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': SUPABASE_KEY,
        'Authorization': `Bearer ${SUPABASE_KEY}`
      },
      body: JSON.stringify({ p_pass: pass })
    });
  } catch (e) { /* the emails went; the timestamp is a nicety */ }

  console.log(`Broadcast: ${sent} sent, ${failed.length} failed, ${open.length} open`);

  return new Response(JSON.stringify({
    sent: sent, failed: failed, open_needs: open.length
  }, null, 2), { status: 200, headers: { 'Content-Type': 'application/json' } });
};

export const config = { path: '/api/ask-everyone' };
