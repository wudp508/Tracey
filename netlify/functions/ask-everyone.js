// One email to every registered friend, listing what is still open.
//
// The recipient list is built in the database from the coordinator
// passphrase, never sent from the browser — otherwise anyone who found
// this endpoint could mail the whole circle.
//
// Sent as individual messages rather than one with everyone in the To
// field, so nobody sees anybody else's address.

// Who a reply reaches. Deliberately separate from who the email comes
// from: these go out under Tracey's name because the appointments are
// hers and she is the organizer on every invitation — but she has asked
// not to field the day-to-day, so replies land with a coordinator.
//
// Falls back to the sender when unset, which is how it behaved before.
// ---------- the words, from settings ----------
//
// Who the page is for and what it is called, so a clone's emails read as
// its own. Read once and kept for a minute: a change in Settings reaches
// the next emails quickly, without a database call for every message.
//
// The same rule as the pages: a sentence's subject is the name, so
// "they" never needs a verb to change; pronouns only appear as
// her/his/their and her/him/them.
let WORDS = null, WORDS_AT = 0;
async function wording() {
  if (WORDS && Date.now() - WORDS_AT < 60000) return WORDS;
  const { SUPABASE_URL, SUPABASE_KEY } = process.env;
  let s = {};
  if (SUPABASE_URL && SUPABASE_KEY) {
    try {
      const r = await fetch(`${SUPABASE_URL}/rest/v1/rpc/public_settings`, {
        method: 'POST',
        // Never let the wording hold anything up. The health check runs
        // this first, and a check that hangs is worse than one that fails.
        signal: AbortSignal.timeout ? AbortSignal.timeout(3000) : undefined,
        headers: { 'Content-Type': 'application/json', 'apikey': SUPABASE_KEY,
                   'Authorization': `Bearer ${SUPABASE_KEY}` },
        body: '{}'
      });
      if (r.ok) s = JSON.parse(await r.text()) || {};
    } catch (e) { /* the defaults below are a perfectly good email */ }
  }
  const pick = (k, d) => (s[k] && String(s[k]).trim()) || d;
  const name = pick('person_name', 'Tracey');
  const p = pick('pronoun', 'she');
  WORDS = {
    name,
    title: pick('page_title', 'For ' + name),
    journal: pick('journal_title', name + '\u2019s journey'),
    her: p === 'he' ? 'his' : p === 'they' ? 'their' : 'her',
    obj: p === 'he' ? 'him' : p === 'they' ? 'them' : 'her'
  };
  WORDS_AT = Date.now();
  return WORDS;
}

// Filled in at the start of each run, so the helpers below can use it.
let W = { name: 'Tracey', title: 'For Tracey', journal: 'Tracey\u2019s journey',
          her: 'her', obj: 'her' };

function replyAddress() {
  const r = (process.env.REPLY_TO || '').trim();
  if (r) return r.split(',')[0].trim();
  const t = (process.env.NOTIFY_TO || '').split(',')[0].trim();
  return t || process.env.NOTIFY_FROM;
}

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
  W = await wording();
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

  // ---------- a message to everyone ----------
  //
  // Not the list of what's open: something a coordinator wants every
  // friend to hear — a change of plan, news, a thank-you. Sent one at a
  // time, like the nudge, so nobody sees anyone else's address.
  if (body.mode === 'message') {
    const json = (o, status) => new Response(JSON.stringify(o), {
      status: status || 200, headers: { 'Content-Type': 'application/json' } });

    const subject = String(body.subject || '').trim().slice(0, 150);
    const message = String(body.message || '').trim().slice(0, 5000);
    if (!subject || !message) return json({ error: 'a subject and a message are both needed' }, 400);
    if (!people.length) return json({ sent: 0, reason: 'nobody registered' });

    // Brevo's free plan allows 300 emails a day, shared by every site
    // that uses the account. One message should never use the day up and
    // leave the calendar invitations with nothing.
    if (people.length > 250) {
      return json({ error: 'more than 250 friends — too many to send in one go on the free plan' }, 400);
    }
    if (dryRun) return json({ dry_run: true, would_send_to: people.length });

    // Her paragraphs as she wrote them. Escaped first, so whatever is
    // typed arrives as words, never as anything an email would run.
    const paras = message.split(/\n\s*\n/).map(t =>
      '<p style="margin:0 0 14px">' + esc(t.trim()).replace(/\n/g, '<br>') + '</p>').join('');

    let sent = 0;
    const failed = [];

    for (const p of people) {
      const first = String(p.name || '').trim().split(/\s+/)[0] || 'there';
      const html = `
        <div style="font-family:-apple-system,Segoe UI,sans-serif;font-size:15px;
                    line-height:1.6;color:#2B2321;max-width:480px">
          <p style="margin:0 0 14px">Hi ${esc(first)},</p>
          ${paras}
          ${site ? `<p style="margin:20px 0 0"><a href="${site}" style="color:#3D5A5B;font-weight:600">Open the signup page</a></p>` : ''}
          <p style="margin:16px 0 0;color:#6E6558;font-size:13px">
            You're getting this because you signed up to help ${esc(W.name)}.</p>
        </div>`;

      try {
        const res = await fetch('https://api.brevo.com/v3/smtp/email', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'accept': 'application/json',
                     'api-key': BREVO_API_KEY },
          body: JSON.stringify({
            sender: { email: NOTIFY_FROM, name: W.title },
            to: [{ email: p.email, name: p.name || undefined }],
            replyTo: { email: replyAddress() },
            subject: subject,
            htmlContent: html,
            textContent: `Hi ${first},\n\n${message}\n\n${site}\n\n`
              + `You're getting this because you signed up to help ${W.name}.`
          })
        });
        if (res.ok) sent++;
        else { failed.push(p.email); console.error('Message failed for', p.email, res.status); }
      } catch (e) {
        failed.push(p.email);
        console.error('Message threw for', p.email, e);
      }
    }

    console.log(`Message to everyone: ${sent} sent, ${failed.length} failed`);
    return json({ sent, failed });
  }

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
          sender: { email: NOTIFY_FROM, name: W.title },
          to: [{ email: p.email, name: p.name || undefined }],
          replyTo: { email: replyAddress() },
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
