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


// Photographs attached to the email. She writes, she attaches a picture,
// it appears in the post — no markdown to remember and nothing to type.
const IMAGE_TYPES = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png',
  gif: 'image/gif', webp: 'image/webp', heic: 'image/heic'
};

function findPhotos(payload) {
  const out = [];
  if (!Array.isArray(payload.attachments)) return out;

  for (const a of payload.attachments) {
    const name = a.file_name || a.fileName || a.name || '';
    const type = (a.content_type || a.contentType || '').toLowerCase();
    const ext = (name.split('.').pop() || '').toLowerCase();

    let mime = null;
    if (type.startsWith('image/')) mime = type.split(';')[0].trim();
    else if (IMAGE_TYPES[ext]) mime = IMAGE_TYPES[ext];
    if (!mime || !IMAGE_TYPES[mime.split('/')[1]] && !mime.startsWith('image/')) continue;

    const content = String(a.content || '').replace(/\s+/g, '');
    if (!content || content.length > 6000000) continue;

    out.push({ mime: mime, bytes: content, caption: name });
  }
  return out;
}

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
  // Mail clients append quoted history and signatures. Cutting them is
  // worth doing — but cutting too eagerly loses the post, which is far
  // worse than leaving a signature on the end.
  //
  // The dash rule is the one that bit: a signature delimiter is exactly
  // two dashes on their own line, while three or more is a horizontal
  // rule in markdown. Matching two-or-more truncated a document at its
  // first section break.
  const cuts = [
    /\n--[ \t]*\n/,                     // exactly two: the signature convention
    /\nOn .{0,80}\bwrote:[ \t]*\n/,    // quoted reply header
    /\n_{10,}\n/,                       // Outlook divider
    /\nSent from my /i,
    /\nGet Outlook for /i
  ];

  let out = text;
  for (const re of cuts) {
    const m = out.match(re);
    if (!m) continue;

    const kept = out.slice(0, m.index);
    // Never let a trim take most of the message. A match that early is
    // far more likely to be part of the writing than a signature.
    if (kept.trim().length < out.trim().length * 0.5) continue;
    if (kept.trim().length < 200) continue;

    out = kept;
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

    // Any photographs she attached, stored against the post. A failure
    // here loses a picture, never the writing.
    let photos = 0;
    try {
      const stored = JSON.parse(out);
      const postId = stored && stored.id;
      const pics = findPhotos(payload);

      if (postId && pics.length) {
        for (const pic of pics) {
          const pr = await fetch(`${SUPABASE_URL}/rest/v1/rpc/add_photo`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'apikey': SUPABASE_KEY,
              'Authorization': `Bearer ${SUPABASE_KEY}`
            },
            body: JSON.stringify({
              p_token: INGEST_TOKEN, p_post_id: postId,
              p_mime: pic.mime, p_bytes: pic.bytes, p_caption: pic.caption
            })
          });
          if (pr.ok) photos++;
          else console.error('Photo rejected:', pr.status, (await pr.text()).slice(0, 200));
        }
      }
    } catch (e) {
      console.error('Could not store the photos', e);
    }

    console.log('Stored post:', title, visibility, photos + ' photo(s)');
    return new Response(out, {
      status: 200, headers: { 'Content-Type': 'application/json' }
    });
  } catch (e) {
    console.error('Supabase unreachable', e);
    return new Response('Upstream unreachable', { status: 502 });
  }
};

export const config = { path: '/api/inbound-post' };
