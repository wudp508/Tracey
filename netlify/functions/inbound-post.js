// Receives one of Tracey's journal posts by email and stores it.
//
// She writes wherever she likes, exports to .md, and emails it to a
// second CloudMailin address. The subject becomes the title. A #close
// tag in the subject keeps the post to the smaller circle.
//
// Markdown is plain text, so nothing is converted here and no package
// is needed. The page renders it when someone reads it.
//
// Environment variables (already set for the other functions):
//   SUPABASE_URL, SUPABASE_KEY, INGEST_TOKEN

// Pulls the markdown out of whatever shape the mail relay sends.
// Prefers a .md attachment; falls back to the plain body so a quick
// note typed straight into Mail still works.
function findMarkdown(payload) {
  const isMd = (name, type) =>
    /\.(md|markdown|txt)$/i.test(name || '') ||
    /text\/(markdown|x-markdown|plain)/i.test(type || '');

  if (Array.isArray(payload.attachments)) {
    for (const a of payload.attachments) {
      const name = a.file_name || a.fileName || a.name || '';
      const type = a.content_type || a.contentType || '';
      if (!isMd(name, type)) continue;

      let content = a.content || '';
      // Attachments usually arrive base64 encoded.
      if (/^[A-Za-z0-9+/=\r\n\s]+$/.test(content) && content.length > 40) {
        try {
          const decoded = Buffer.from(content, 'base64').toString('utf8');
          if (decoded.trim()) content = decoded;
        } catch (e) { /* keep the original */ }
      }
      if (content.trim()) return content;
    }
  }

  for (const key of ['plain', 'text', 'body']) {
    if (typeof payload[key] === 'string' && payload[key].trim()) {
      return payload[key];
    }
  }
  return null;
}

// Mail clients append quoted history and signatures. Trim the common
// markers so a reply-to-self does not drag the previous post along.
function trimReplyChrome(text) {
  const cuts = [
    /\n-{2,}\s*\n/,                       // signature delimiter
    /\nOn .{0,80}\bwrote:\s*\n/,          // quoted reply header
    /\n_{10,}\n/,                         // Outlook divider
    /\nSent from my /i
  ];
  let out = text;
  for (const re of cuts) {
    const m = out.match(re);
    if (m && m.index > 40) out = out.slice(0, m.index);
  }
  return out.trim();
}

export default async (request) => {
  if (request.method !== 'POST') {
    return new Response('Method not allowed', { status: 405 });
  }

  const { SUPABASE_URL, SUPABASE_KEY, INGEST_TOKEN } = process.env;
  if (!SUPABASE_URL || !SUPABASE_KEY || !INGEST_TOKEN) {
    console.error('Missing environment variables');
    return new Response('Server not configured', { status: 500 });
  }

  let payload;
  try {
    const ct = (request.headers.get('content-type') || '').toLowerCase();
    if (ct.includes('application/json')) {
      payload = await request.json();
    } else {
      const form = await request.formData();
      payload = {};
      for (const [k, v] of form.entries()) {
        if (typeof v === 'string') {
          payload[k] = v;
        } else {
          payload.attachments = payload.attachments || [];
          payload.attachments.push({
            content_type: v.type, file_name: v.name, content: await v.text()
          });
        }
      }
    }
  } catch (e) {
    console.error('Could not read request body', e);
    return new Response('Bad request', { status: 400 });
  }

  const headers = payload.headers || {};
  let subject = payload.subject || headers.Subject || headers.subject || '';
  const mailUid = headers['Message-ID'] || headers['Message-Id'] ||
                  headers['message-id'] || payload.message_id || null;

  const markdown = findMarkdown(payload);
  if (!markdown) {
    console.log('No markdown found in message');
    // 200 so the sender gets no bounce for, say, an autoreply.
    return new Response('No post content', { status: 200 });
  }

  // #close anywhere in the subject keeps this to the smaller circle.
  let visibility = 'approved';
  if (/#close\b/i.test(subject)) {
    visibility = 'close';
    subject = subject.replace(/#close\b/ig, '');
  }
  const title = subject.replace(/\s{2,}/g, ' ').trim() || 'Untitled';

  const body = trimReplyChrome(markdown);

  try {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/ingest_post`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': SUPABASE_KEY,
        'Authorization': `Bearer ${SUPABASE_KEY}`
      },
      body: JSON.stringify({
        p_token: INGEST_TOKEN,
        p_title: title,
        p_body: body,
        p_visibility: visibility,
        p_mail_uid: mailUid
      })
    });
    const out = await res.text();
    if (!res.ok) {
      console.error('Supabase rejected the post:', res.status, out);
      return new Response('Upstream error', { status: 502 });
    }
    console.log('Stored post:', title, visibility);
    return new Response(out, {
      status: 200, headers: { 'Content-Type': 'application/json' }
    });
  } catch (e) {
    console.error('Supabase unreachable', e);
    return new Response('Upstream unreachable', { status: 502 });
  }
};

export const config = { path: '/api/inbound-post' };
