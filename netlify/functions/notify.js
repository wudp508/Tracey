import nodemailer from 'nodemailer';

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


// ---------- forwarding the real invitation ---------------------------

// Adds the volunteer as an attendee on the original invitation, leaving
// the UID, ORGANIZER and SEQUENCE untouched. That is what lets their
// acceptance land back on the genuine event in Outlook.
function addAttendee(ics, email, name) {
  if (!ics) return null;
  const lines = ics.replace(/\r\n/g, '\n').split('\n');
  const out = [];
  let inEvent = false, added = false;

  const attendee =
    'ATTENDEE;CUTYPE=INDIVIDUAL;ROLE=REQ-PARTICIPANT;PARTSTAT=NEEDS-ACTION;' +
    'RSVP=TRUE;CN=' + (name || email).replace(/[;,:]/g, ' ') +
    ':mailto:' + email;

  for (const line of lines) {
    if (/^BEGIN:VEVENT\s*$/i.test(line)) inEvent = true;

    // Drop any existing entry for this address so re-sends do not double up.
    if (inEvent && /^ATTENDEE/i.test(line) &&
        line.toLowerCase().includes('mailto:' + email.toLowerCase())) {
      continue;
    }

    if (inEvent && !added && /^END:VEVENT\s*$/i.test(line)) {
      out.push(attendee);
      added = true;
      inEvent = false;
    }
    out.push(line);
  }

  let result = out.join('\r\n');
  // Outlook sends METHOD:REQUEST already; make sure it is there.
  if (!/^METHOD:/im.test(result)) {
    result = result.replace(/^BEGIN:VCALENDAR\s*$/im,
                            'BEGIN:VCALENDAR\r\nMETHOD:REQUEST');
  }
  return result;
}

// Sends the invitation to the volunteer.
//

// ---------- keeping a record of what went out ----------
//
// Email is fire-and-forget so a friend can still claim when Brevo is
// down. The cost of that is silence: an invitation that never arrived
// used to leave no trace at all. Every attempt is now recorded, with
// enough to send it again.
//
// This never throws. A failure to record a failure must not become a
// second failure.
async function record(kind, ok, recipient, needId, detail, payload) {
  const { SUPABASE_URL, SUPABASE_KEY, INGEST_TOKEN } = process.env;
  if (!SUPABASE_URL || !SUPABASE_KEY || !INGEST_TOKEN) return;
  try {
    await fetch(`${SUPABASE_URL}/rest/v1/rpc/log_send`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': SUPABASE_KEY,
        'Authorization': `Bearer ${SUPABASE_KEY}`
      },
      body: JSON.stringify({
        p_token: INGEST_TOKEN,
        p_kind: kind,
        p_ok: ok === true,
        p_recipient: recipient || null,
        p_need_id: needId || null,
        p_detail: detail ? String(detail).slice(0, 500) : null,
        p_payload: payload || null
      })
    });
  } catch (e) {
    console.error('Could not record the send', e);
  }
}

// The calendar has to arrive as an inline text/calendar part with
// method=REQUEST, not as a file attachment. That is what makes Gmail
// show its Yes / Maybe / No card instead of a paperclip. Brevo's HTTP
// API cannot express that, so this goes over SMTP where we control the
// message structure.
async function sendInvite(env, need, why) {
  const ics = addAttendee(need.ics, need.email, need.volunteer);
  if (!ics) {
    return 'no stored invitation for this need';
  }

  if (!env.SMTP_LOGIN || !env.SMTP_KEY) {
    return 'SMTP_LOGIN or SMTP_KEY not set';
  }

  const when = `${fmtDate(need.date)}, ${need.start_time}${need.end_time ? '–' + need.end_time : ''}`;

  const html = `
    <div style="font-family:-apple-system,Segoe UI,sans-serif;font-size:15px;
                line-height:1.55;color:#2B2321;max-width:480px">
      <p style="font-size:17px;font-weight:600;margin:0 0 14px">${
        why === 'updated' ? 'This has changed' : 'Thank you for signing up'}</p>
      <p style="margin:0 0 14px">
        <strong>${esc(need.title)}</strong><br>
        ${esc(when)}
        ${need.location ? '<br>' + esc(need.location) : ''}
      </p>
      ${need.instructions ? `<p style="margin:0 0 14px">${esc(need.instructions)}</p>` : ''}
      ${why === 'updated'
        ? `<p style="margin:0 0 14px">Tracey has changed this one. The details
           above are the new ones, and your calendar should update on its
           own.</p>
           <p style="margin:0 0 14px"><strong>If the new time does not work for
           you, please free up the slot on the page.</strong> Someone else can
           then take it, and nobody is left assuming it is covered.</p>`
        : `<p style="margin:0 0 14px">This should appear on your calendar
           automatically. If the time or place changes you will get an update,
           so there is nothing to keep track of.</p>
           <p style="margin:0 0 14px">If something comes up and you cannot make
           it, free up the slot on the page and someone else can take it.</p>`}
      ${env.SITE_URL ? `<p style="margin:18px 0 0"><a href="${env.SITE_URL}" style="color:#3D5A5B">Open the signup page</a></p>` : ''}
    </div>`;

  const text = [
    why === 'updated' ? 'This has changed' : 'Thank you for signing up',
    '',
    need.title,
    when,
    need.location || '',
    '',
    need.instructions || '',
    '',
    why === 'updated'
      ? 'If the new time does not work for you, please free up the slot on the page.'
      : 'This should appear on your calendar automatically.',
    env.SITE_URL || ''
  ].filter(Boolean).join('\n');

  try {
    const transport = nodemailer.createTransport({
      host: 'smtp-relay.brevo.com',
      port: 587,
      secure: false,
      auth: { user: env.SMTP_LOGIN, pass: env.SMTP_KEY }
    });

    await transport.sendMail({
      from: { name: 'For Tracey', address: env.NOTIFY_FROM },
      to: need.volunteer ? `"${need.volunteer}" <${need.email}>` : need.email,
      replyTo: env.NOTIFY_FROM,
      subject: (why === 'updated' ? 'Changed: ' : '') + `${need.title} — ${when}`,
      text: text,
      html: html,
      // Inline calendar part. alternatives places it beside the html body
      // inside multipart/alternative, which is what mail clients look for.
      alternatives: [{
        contentType: 'text/calendar; charset=UTF-8; method=REQUEST',
        content: Buffer.from(ics, 'utf8')
      }],
      // A copy as a file too, for clients that ignore the inline part.
      attachments: [{
        filename: 'invite.ics',
        content: Buffer.from(ics, 'utf8'),
        contentType: 'application/ics'
      }],
      // Helps Outlook and Apple Mail treat it as a meeting request.
      headers: { 'Content-Class': 'urn:content-classes:calendarmessage' }
    });

    return 'invite sent (inline calendar)';
  } catch (e) {
    return 'invite failed: ' + String(e && e.message ? e.message : e).slice(0, 250);
  }
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
      SITE_URL:      process.env.SITE_URL || null,
      SMTP_LOGIN:    process.env.SMTP_LOGIN || null,
      SMTP_KEY:      !!process.env.SMTP_KEY
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

  // Someone has asked to read Tracey's journal. No need lookup involved.
  if (action === 'access-request') {
    const who = (body.name || '').trim();
    const addr = (body.email || '').trim();
    if (!addr) return new Response('Bad request', { status: 400 });

    const site = SITE_URL || '';
    const html = `
      <div style="font-family:-apple-system,Segoe UI,sans-serif;font-size:15px;
                  line-height:1.55;color:#2B2321;max-width:480px">
        <p style="font-size:17px;font-weight:600;margin:0 0 14px">Someone asked to read Tracey's updates</p>
        <p style="margin:0 0 14px"><strong>${esc(who || addr)}</strong><br>${esc(addr)}</p>
        <p style="margin:0 0 14px">They cannot see anything she has written until you approve them.
        Open the coordinator view to decide.</p>
        ${site ? `<p style="margin:18px 0 0"><a href="${site}" style="color:#3D5A5B">Open the signup page</a></p>` : ''}
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
          to: NOTIFY_TO.split(',').map(e => e.trim()).filter(Boolean).map(e => ({ email: e })),
          subject: `${who || addr} asked to read Tracey's updates`,
          htmlContent: html,
          textContent: `${who || addr} (${addr}) asked to read Tracey's updates. `
                     + `They cannot see anything until you approve them.`
        })
      });
      if (!res.ok) {
        console.error('Access-request email failed:', res.status, await res.text());
        return new Response('Send failed', { status: 502 });
      }
      return new Response(JSON.stringify({ sent: true }), {
        status: 200, headers: { 'Content-Type': 'application/json' }
      });
    } catch (e) {
      console.error('Brevo unreachable', e);
      return new Response('Send failed', { status: 502 });
    }
  }

  // Telling a friend where she lives, once, when a coordinator says so.
  // In an inbox rather than only on a page they would have to go and
  // find — and worth a sentence about not passing it on.
  if (action === 'address-shared') {
    const addr = (body.address || '').trim();
    const to = (body.email || '').trim();
    const who = (body.name || '').trim();
    if (!addr || !to) return new Response('Bad request', { status: 400 });

    const first = who.split(/\s+/)[0] || 'there';
    const site = (SITE_URL || '').replace(/\/+$/, '');

    const html = `
      <div style="font-family:-apple-system,Segoe UI,sans-serif;font-size:15px;
                  line-height:1.6;color:#2B2321;max-width:460px">
        <p style="font-size:17px;font-weight:600;margin:0 0 14px">
          ${esc(first)}, here is Tracey&rsquo;s address</p>
        <p style="margin:0 0 16px;font-size:16px">
          <strong>${esc(addr)}</strong></p>
        <p style="margin:0 0 14px">Most pickups are from her door, so this is
          what you need for a ride. It will show on the signup page from now on
          as well.</p>
        <p style="margin:0;color:#6E6558;font-size:13.5px">
          Please keep it to yourself. The signup page can be forwarded, which is
          why it does not show her address to everyone.</p>
        ${site ? `<p style="margin:18px 0 0"><a href="${site}" style="color:#3D5A5B">Open the signup page</a></p>` : ''}
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
          to: [{ email: to, name: who || undefined }],
          replyTo: { email: NOTIFY_FROM },
          subject: "Tracey's address, for when you are driving",
          htmlContent: html,
          textContent: `${first}, here is Tracey's address.\n\n${addr}\n\n`
            + `Most pickups are from her door, so this is what you need for a `
            + `ride. Please keep it to yourself \u2014 the signup page can be `
            + `forwarded, which is why it does not show her address to everyone.`
        })
      });
      if (!res.ok) {
        const why = await res.text();
        console.error('Address email failed:', res.status, why);
        await record('address', false, to, null, res.status + ': ' + why.slice(0, 200),
                     { action: 'address-shared', email: to, name: who, address: addr });
        return new Response('Send failed', { status: 502 });
      }
      await record('address', true, to, null, null, null);
      return new Response(JSON.stringify({ sent: true }), {
        status: 200, headers: { 'Content-Type': 'application/json' }
      });
    } catch (e) {
      console.error('Brevo unreachable', e);
      await record('address', false, to, null, String(e).slice(0, 200),
                   { action: 'address-shared', email: to, name: who, address: addr });
      return new Response('Send failed', { status: 502 });
    }
  }

  // A friend reporting that something is not working. The value here is
  // not the report itself so much as the permission: someone who would
  // never text about a small thing will tap a button that invites it.
  if (action === 'problem') {
    const who = (body.name || '').trim();
    const addr = (body.email || '').trim();
    const said = String(body.said || '').trim().slice(0, 2000);
    const context = String(body.context || '').trim().slice(0, 300);
    if (!said) return new Response('Nothing to send', { status: 400 });

    const to = (process.env.ALERT_TO || '').trim()
      || (NOTIFY_TO || '').split(',')[0].trim();
    if (!to) return new Response('Nowhere to send it', { status: 500 });

    const html = `
      <div style="font-family:-apple-system,Segoe UI,sans-serif;font-size:15px;
                  line-height:1.55;color:#2B2321;max-width:520px">
        <p style="font-size:17px;font-weight:600;margin:0 0 14px">
          ${esc(who || addr || 'Someone')} reported a problem</p>
        <div style="background:#FBF9F4;border-left:3px solid #A85C32;
                    padding:12px 14px;margin:0 0 16px;white-space:pre-wrap">${esc(said)}</div>
        <p style="margin:0 0 6px;color:#6E6558;font-size:13px">
          ${esc(who)}${addr ? ' &middot; ' + esc(addr) : ''}</p>
        ${context ? `<p style="margin:0;color:#6E6558;font-size:12.5px">${esc(context)}</p>` : ''}
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
          to: to.split(',').map(e => e.trim()).filter(Boolean).map(e => ({ email: e })),
          // Replying goes to the friend, not to the system, so a quick
          // answer needs no address hunting.
          replyTo: addr ? { email: addr, name: who || undefined }
                        : { email: NOTIFY_FROM },
          subject: `Problem reported by ${who || addr || 'a friend'}`,
          htmlContent: html,
          textContent: `${who || addr || 'Someone'} reported a problem:\n\n`
            + said + `\n\n${who}${addr ? ' · ' + addr : ''}\n${context}`
        })
      });
      if (!res.ok) {
        console.error('Problem report failed:', res.status, await res.text());
        return new Response('Send failed', { status: 502 });
      }
      return new Response(JSON.stringify({ sent: true }), {
        status: 200, headers: { 'Content-Type': 'application/json' }
      });
    } catch (e) {
      console.error('Brevo unreachable', e);
      return new Response('Send failed', { status: 502 });
    }
  }

  // Someone has been let in to read Tracey's journal — or is being sent
  // the link again. Without this they would only find out by happening
  // to open the page and noticing the button had changed.
  if (action === 'access-granted') {
    const addr = (body.email || '').trim();
    const who = (body.name || '').trim();
    const again = body.again === true;
    if (!addr) return new Response('Bad request', { status: 400 });

    const first = who.split(/\s+/)[0] || 'there';
    // The signup page, not the journal. One address for everybody:
    // a friend who saved the journal link to their home screen would get
    // an icon that opens her writing rather than the list of needs.
    const site = (SITE_URL || '').replace(/\/+$/, '');

    const html = `
      <div style="font-family:-apple-system,Segoe UI,sans-serif;font-size:15px;
                  line-height:1.6;color:#2B2321;max-width:460px">
        <p style="font-size:17px;font-weight:600;margin:0 0 14px">
          ${esc(first)}, you can read Tracey's updates</p>
        <p style="margin:0 0 14px">${again
          ? 'Here is the link again, in case it went astray.'
          : 'She has been writing about how her recovery is going, and you are '
            + 'welcome to read it.'}</p>
        <p style="margin:0 0 18px">Open the signup page and tap
          <strong>Tracey&rsquo;s journey</strong>.</p>
        <p style="margin:0 0 18px">
          <a href="${site}" style="color:#3D5A5B;font-weight:600">${esc(site)}</a></p>
        <p style="margin:0;color:#6E6558;font-size:13.5px">
          This is Tracey&rsquo;s own writing, shared with people she has chosen.
          <strong>Please don&rsquo;t forward it, or pass on what she has
          written.</strong> The link itself will not open for anyone else, but
          her words travel easily once they leave here.</p>
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
          to: [{ email: addr, name: who || undefined }],
          replyTo: { email: NOTIFY_FROM },
          subject: again
            ? "Tracey's updates \u2014 the link again"
            : "You can read Tracey's updates",
          htmlContent: html,
          textContent: `${first}, you can read Tracey's updates.\n\n`
            + (again ? 'Here is the link again.\n\n'
                     : 'She has been writing about how her recovery is going.\n\n')
            + `Open the signup page and tap "Tracey's journey".\n\n`
            + `${site}\n\n`
            + `This is Tracey's own writing, shared with people she has chosen. `
            + `Please don't forward it, or pass on what she has written. The `
            + `link itself will not open for anyone else, but her words travel `
            + `easily once they leave here.`
        })
      });
      if (!res.ok) {
        const why = await res.text();
        console.error('Access-granted email failed:', res.status, why);
        await record('journal-link', false, addr, null,
                     res.status + ': ' + why.slice(0, 200),
                     { action: 'access-granted', email: addr, name: who, again: again });
        return new Response('Send failed', { status: 502 });
      }
      await record('journal-link', true, addr, null, null, null);
      return new Response(JSON.stringify({ sent: true, to: addr }), {
        status: 200, headers: { 'Content-Type': 'application/json' }
      });
    } catch (e) {
      console.error('Brevo unreachable', e);
      return new Response('Send failed', { status: 502 });
    }
  }

  if (!id || (action !== 'claimed' && action !== 'released'
              && action !== 'cancelled' && action !== 'updated')) {
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

  // A coordinator removed the need. The volunteer is told directly,
  // because nothing else will tell them.
  if (action === 'cancelled') {
    const when = `${fmtDate(need.date)}, ${need.start_time}${need.end_time ? '–' + need.end_time : ''}`;

    if (need.email) {
      const vHtml = `
        <div style="font-family:-apple-system,Segoe UI,sans-serif;font-size:15px;
                    line-height:1.55;color:#2B2321;max-width:480px">
          <p style="font-size:17px;font-weight:600;margin:0 0 14px">This is no longer needed</p>
          <p style="margin:0 0 14px">
            <strong>${esc(need.title)}</strong><br>${esc(when)}
            ${need.location ? '<br>' + esc(need.location) : ''}
          </p>
          <p style="margin:0 0 14px">Plans changed and this has been cancelled, so
          there is nothing for you to do. Thank you for offering \u2014 it was
          appreciated.</p>
          <p style="margin:0 0 14px">You may still have it on your calendar; it is
          safe to delete.</p>
          ${SITE_URL ? `<p style="margin:18px 0 0"><a href="${SITE_URL}" style="color:#3D5A5B">See what else is open</a></p>` : ''}
        </div>`;

      try {
        const vres = await fetch('https://api.brevo.com/v3/smtp/email', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'accept': 'application/json',
            'api-key': BREVO_API_KEY
          },
          body: JSON.stringify({
            sender: { email: NOTIFY_FROM, name: 'For Tracey' },
            to: [{ email: need.email, name: need.volunteer || undefined }],
            replyTo: { email: NOTIFY_FROM },
            subject: `Cancelled: ${need.title} \u2014 ${when}`,
            htmlContent: vHtml,
            textContent: `This is no longer needed.\n\n${need.title}\n${when}\n\n`
                       + `Plans changed and this has been cancelled, so there is `
                       + `nothing for you to do. Thank you for offering.`
          })
        });
        if (!vres.ok) {
          const why = await vres.text();
          console.error('Cancellation to volunteer failed:', vres.status, why);
          await record('cancelled', false, need.email, id,
                       vres.status + ': ' + why.slice(0, 200),
                       { id: id, action: 'cancelled' });
        } else {
          await record('cancelled', true, need.email, id, null, null);
        }
      } catch (e) {
        console.error('Could not tell the volunteer', e);
        await record('cancelled', false, need.email, id, String(e).slice(0, 200),
                     { id: id, action: 'cancelled' });
      }
    }

    return new Response(JSON.stringify({
      sent: true,
      told: need.email || null,
      was_invited: need.invited === true
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }

  if (action === 'updated') {
    subject = `Changed: ${need.title}`;
    heading = 'This changed, and the volunteer has been told';
    lines = [
      `<strong>${esc(need.title)}</strong>`,
      esc(when),
      need.location ? esc(need.location) : '',
      '',
      `Covered by: <strong>${esc(need.volunteer || '')}</strong>`,
      '',
      `<em>The updated invitation has been sent to them, so their calendar `
        + `will show the new time. Nothing for you to do.</em>`
    ];
  } else if (action === 'claimed') {
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
      const why = await res.text();
      console.error('Coordinator email failed:', res.status, why);
      await record(action, false, NOTIFY_TO, id,
                   res.status + ': ' + why.slice(0, 200),
                   { id: id, action: action });
    } else {
      await record(action, true, NOTIFY_TO, id, null, null);
    }
    if (!res.ok) {
      console.error('Brevo rejected the send:', res.status, out);
      return new Response(JSON.stringify({ error: 'brevo rejected', status: res.status, detail: out.slice(0, 300) }), {
        status: 502, headers: { 'Content-Type': 'application/json' }
      });
    }
    console.log('Notified', action, need.title);

    // On a claim, forward the genuine Outlook invitation to the volunteer.
    // Also on an update: Tracey has moved the time, and the person who
    // signed up needs the new one. Without this they keep whatever was
    // forwarded when they claimed, and turn up at the old time.
    let inviteResult = 'not applicable';
    if (action === 'claimed' || action === 'updated') {
      try {
        const full = await fetch(`${SUPABASE_URL}/rest/v1/rpc/claim_invite`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'apikey': SUPABASE_KEY,
            'Authorization': `Bearer ${SUPABASE_KEY}`
          },
          body: JSON.stringify({ p_token: INGEST_TOKEN, p_id: id })
        });
        if (full.ok) {
          const detail = await full.json();
          if (detail && detail.email) {
            inviteResult = await sendInvite({
              NOTIFY_FROM, SITE_URL,
              SMTP_LOGIN: process.env.SMTP_LOGIN,
              SMTP_KEY:   process.env.SMTP_KEY
            }, detail, action);

            // The calendar invitation is the one a friend actually
            // needs. If it did not go, that has to be visible.
            var inviteOk = inviteResult.indexOf('invite sent') === 0;
            await record('invite', inviteOk, detail.email, id,
                         inviteOk ? null : inviteResult,
                         { id: id, action: action });
          } else {
            inviteResult = 'no volunteer email on record';
          }
        } else {
          inviteResult = 'could not read need: ' + full.status;
        }
      } catch (e) {
        inviteResult = 'invite threw: ' + String(e).slice(0, 200);
      }
      console.log('Invite:', inviteResult);
    }

    return new Response(JSON.stringify({ sent: true, invite: inviteResult }), {
      status: 200, headers: { 'Content-Type': 'application/json' }
    });
  } catch (e) {
    console.error('Brevo unreachable', e);
    return new Response('Send failed', { status: 502 });
  }
};

export const config = { path: '/api/notify' };
