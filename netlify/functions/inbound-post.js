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
// Only an attached .md or .txt — no fallback to the body. Split out so
// the formatted HTML body can be tried before the plain one.
function findAttachment(payload) {
  const isMd = (name, type) =>
    /\.(md|markdown|txt)$/i.test(name || '') ||
    /text\/(markdown|x-markdown|plain)/i.test(type || '');

  if (!Array.isArray(payload.attachments)) return null;
  for (const a of payload.attachments) {
    const name = a.file_name || a.fileName || a.name || '';
    const type = a.content_type || a.contentType || '';
    if (!isMd(name, type)) continue;

    let content = a.content || '';
    if (/^[A-Za-z0-9+/=\r\n\s]+$/.test(content) && content.length > 40) {
      try {
        const decoded = Buffer.from(content, 'base64').toString('utf8');
        if (decoded.trim()) content = decoded;
      } catch (e) { /* keep the original */ }
    }
    if (content.trim()) return content;
  }
  return null;
}

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


// ---------- her formatting, carried across ----------
//
// Mail clients send two versions of every message: plain text, with her
// headings and bold stripped out, and HTML, which keeps them. We used to
// read the plain one. This turns the HTML into the markdown the journal
// already knows how to render.
//
// Deliberately not carried: fonts, colours, sizes, indentation. The
// journal has its own typography and every post should look like it
// belongs to the same place.
//
// Word is the awkward one. Its HTML says "bold" as a styled span rather
// than a <b>, makes headings out of styled paragraphs, and — worst — often
// writes a bulleted list as ordinary paragraphs that happen to start with
// a bullet character. All three are handled here rather than trusting
// the tags.

function decodeEntities(s) {
  const named = {
    nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'",
    rsquo: '\u2019', lsquo: '\u2018', rdquo: '\u201d', ldquo: '\u201c',
    mdash: '\u2014', ndash: '\u2013', hellip: '\u2026', bull: '\u2022',
    middot: '\u00b7', copy: '\u00a9', reg: '\u00ae', trade: '\u2122',
    eacute: '\u00e9', egrave: '\u00e8', agrave: '\u00e0', ccedil: '\u00e7',
    uuml: '\u00fc', ouml: '\u00f6', auml: '\u00e4', times: '\u00d7'
  };
  return String(s)
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&([a-z]+);/gi, (m, n) => named[n.toLowerCase()] !== undefined
      ? named[n.toLowerCase()] : m);
}

function attr(tag, name) {
  const m = tag.match(new RegExp(name + '\\s*=\\s*("([^"]*)"|\'([^\']*)\'|([^\\s>]+))', 'i'));
  return m ? (m[2] !== undefined ? m[2] : m[3] !== undefined ? m[3] : m[4]) : '';
}

// What a span's style says about weight and slant. Word writes bold as
// font-weight:bold or 700; anything 600 and up reads as bold on screen.
function styleSays(tag) {
  const st = attr(tag, 'style').toLowerCase();
  const w = st.match(/font-weight\s*:\s*(bold|bolder|\d+)/);
  const bold = !!w && (w[1] === 'bold' || w[1] === 'bolder' || parseInt(w[1], 10) >= 600);
  const italic = /font-style\s*:\s*italic/.test(st);
  const strike = /text-decoration[^;]*line-through/.test(st);
  return { bold, italic, strike };
}

function htmlToMarkdown(html) {
  if (!html) return '';
  let h = String(html);

  // ---------- things that are never content ----------
  h = h.replace(/<!--\[if[\s\S]*?<!\[endif\]-->/gi, '')     // Word's conditionals
       .replace(/<!--[\s\S]*?-->/g, '')
       .replace(/<(head|style|script|title|xml|o:p)[^>]*>[\s\S]*?<\/\1>/gi, '')
       .replace(/<\/?(o|v|w|m):[^>]*>/gi, '')                 // Office namespaces
       .replace(/<img[^>]*>/gi, '');                          // photos come separately

  // In HTML a line break in the source is only a space. It is the tags
  // that make lines. Mail clients wrap their source at seventy-odd
  // characters, so keeping those breaks split headings in half and
  // stopped italics being recognised.
  h = h.replace(/<pre\b[\s\S]*?<\/pre>/gi, (m) => m.replace(/\n/g, '\u0004'))
       .replace(/[\r\n\t]+/g, ' ')
       .replace(/ {2,}/g, ' ')
       .replace(/\u0004/g, '\n');

  // Quoted replies: Apple Mail and Gmail wrap them, and they are never
  // part of what she wrote.
  h = h.replace(/<blockquote[^>]*type=["']?cite[\s\S]*$/i, '')
       .replace(/<div[^>]*class=["'][^"']*gmail_quote[\s\S]*$/i, '');

  // ---------- inline formatting ----------
  // Spans first, because Word puts everything in them. A span that says
  // bold becomes <b>, and so on, so the tag rules below handle it.
  h = h.replace(/<span\b[^>]*>/gi, (tag) => {
    const s = styleSays(tag);
    return (s.bold ? '<b>' : '') + (s.italic ? '<i>' : '') + (s.strike ? '<s>' : '')
      + '<span-open data-b="' + (s.bold ? 1 : 0) + '" data-i="' + (s.italic ? 1 : 0)
      + '" data-s="' + (s.strike ? 1 : 0) + '">';
  });
  // Close each span with whatever it opened, innermost first.
  for (let guard = 0; guard < 50 && /<span-open/.test(h); guard++) {
    h = h.replace(/<span-open data-b="(\d)" data-i="(\d)" data-s="(\d)">((?:(?!<span-open)[\s\S])*?)<\/span>/i,
      (_, b, i, s, inner) => inner + (s === '1' ? '</s>' : '') + (i === '1' ? '</i>' : '')
        + (b === '1' ? '</b>' : ''));
  }
  h = h.replace(/<span-open[^>]*>/gi, '').replace(/<\/span>/gi, '');

  h = h.replace(/<(b|strong)\b[^>]*>/gi, '\u0001B').replace(/<\/(b|strong)>/gi, '\u0001b')
       .replace(/<(i|em)\b[^>]*>/gi, '\u0001I').replace(/<\/(i|em)>/gi, '\u0001i')
       .replace(/<(s|strike|del)\b[^>]*>/gi, '\u0001S').replace(/<\/(s|strike|del)>/gi, '\u0001s')
       .replace(/<code\b[^>]*>/gi, '`').replace(/<\/code>/gi, '`');

  // Links: keep only real web addresses, as the renderer does.
  h = h.replace(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi, (_, a, text) => {
    const href = attr('<a' + a + '>', 'href');
    const t = text.replace(/<[^>]+>/g, '').trim();
    if (!/^https?:\/\//i.test(href) || !t) return text;
    return t === href ? href : '[' + t + '](' + href + ')';
  });

  // ---------- tables ----------
  h = h.replace(/<table\b[^>]*>([\s\S]*?)<\/table>/gi, (_, body) => {
    const rows = [];
    body.replace(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi, (__, tr) => {
      const cells = [];
      tr.replace(/<t[hd]\b[^>]*>([\s\S]*?)<\/t[hd]>/gi, (___, td) => {
        cells.push(td.replace(/<br\s*\/?>/gi, ' ').replace(/<[^>]+>/g, '')
          .replace(/\|/g, '/').replace(/\s+/g, ' ').trim());
        return '';
      });
      if (cells.length) rows.push(cells);
      return '';
    });
    if (!rows.length) return '';
    const width = Math.max.apply(null, rows.map(r => r.length));
    const line = r => '| ' + Array.from({ length: width }, (_, k) => r[k] || '').join(' | ') + ' |';
    return '\n\n' + line(rows[0]) + '\n| ' + Array(width).fill('---').join(' | ') + ' |\n'
      + rows.slice(1).map(line).join('\n') + '\n\n';
  });

  // ---------- lists, the proper kind ----------
  // Handled from the inside out, so a nested list knows its depth.
  let depthMarker = 0;
  for (let guard = 0; guard < 20 && /<(ul|ol)\b/i.test(h); guard++) {
    h = h.replace(/<(ul|ol)\b[^>]*>((?:(?!<(?:ul|ol)\b)[\s\S])*?)<\/\1>/i, (_, kind, inner) => {
      let n = 0;
      const items = [];
      inner.replace(/<li\b[^>]*>([\s\S]*?)(?=<li\b|$)/gi, (__, li) => {
        n++;
        const text = li.replace(/<\/li>/gi, '');
        items.push({ mark: kind.toLowerCase() === 'ol' ? n + '.' : '-', text });
        return '';
      });
      depthMarker++;
      return '\n\u0002LIST' + depthMarker + '\n'
        + items.map(it => '\u0003' + it.mark + ' ' + it.text.replace(/\n\u0003/g, '\n  \u0003')).join('\n')
        + '\n\u0002END\n';
    });
  }

  // ---------- blocks ----------
  // A heading is already bold; Word often says so again, which would
  // leave literal asterisks in it.
  const plainHeading = t => t.replace(/\u0001[Bb]/g, '').trim();
  h = h.replace(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/gi,
    (_, n, t) => '\n\n' + '#'.repeat(Math.min(parseInt(n, 10), 4)) + ' '
      + plainHeading(t) + '\n\n');

  // Word's own heading styles, which arrive as paragraphs.
  h = h.replace(/<p\b([^>]*class=["']?Mso(Title|Heading(\d)|Subtitle)[^>]*)>([\s\S]*?)<\/p>/gi,
    (_, a, kind, lvl, t) => {
      const level = kind.toLowerCase() === 'title' ? 1
                  : kind.toLowerCase() === 'subtitle' ? 3
                  : Math.min(parseInt(lvl || '2', 10), 4);
      return '\n\n' + '#'.repeat(level) + ' ' + plainHeading(t) + '\n\n';
    });

  h = h.replace(/<blockquote\b[^>]*>([\s\S]*?)<\/blockquote>/gi, (_, t) =>
    '\n\n' + t.replace(/<[^>]+>/g, '\n').split('\n').map(x => x.trim())
      .filter(Boolean).map(x => '> ' + x).join('\n') + '\n\n');

  h = h.replace(/<hr\b[^>]*>/gi, '\n\n---\n\n')
       .replace(/<br\s*\/?>/gi, '  \n')
       .replace(/<\/(p|div|section|article|header|footer)>/gi, '\n\n')
       .replace(/<(p|div|section|article|header|footer)\b[^>]*>/gi, '\n\n')
       .replace(/<[^>]+>/g, '');                              // anything left

  h = decodeEntities(h);

  // ---------- markers back into markdown ----------
  // Collapse emphasis that opens and closes with nothing between, which
  // Word produces constantly and which would otherwise show as ****.
  h = h.replace(/\u0001B(\s*)\u0001b/g, '$1').replace(/\u0001I(\s*)\u0001i/g, '$1')
       .replace(/\u0001S(\s*)\u0001s/g, '$1');

  // Keep the spaces outside the asterisks, or "**word **" fails to render.
  const wrap = (open, close, mark) => {
    h = h.replace(new RegExp(open + '(\\s*)([\\s\\S]*?)(\\s*)' + close, 'g'),
      (_, a, t, b) => t ? a + mark + t + mark + b : a + b);
  };
  wrap('\u0001B', '\u0001b', '**');
  wrap('\u0001I', '\u0001i', '*');
  wrap('\u0001S', '\u0001s', '~~');
  h = h.replace(/\u0001[BbIiSs]/g, '');

  // Lists: one item per line, indent by nesting.
  h = h.replace(/\n?\u0002LIST\d+\n/g, '\n').replace(/\n?\u0002END\n?/g, '\n');
  h = h.split('\n').map(line => {
    const m = line.match(/^(\s*)\u0003(.*)$/);
    return m ? m[1] + m[2].replace(/\s+/g, ' ').trim() : line;
  }).join('\n');

  // ---------- Word's pretend lists ----------
  // A paragraph starting with a bullet glyph or "1." is a list item that
  // Word wrote as prose.
  // It keeps the line's own indentation: a real nested list has already
  // been turned into indented "- " lines above, and trimming them here
  // flattened every nested list into one level.
  h = h.split('\n').map(line => {
    const lead = (line.match(/^[ \t]*/) || [''])[0];
    const t = line.slice(lead.length);
    let m = t.match(/^[\u2022\u00b7\u25aa\u25cf\u2023\u2043\u25e6o\u00a7\uf0b7-]\s+(.+)$/);
    if (m && t.length > 2) return lead + '- ' + m[1];
    m = t.match(/^(\d{1,2})[.)]\s+(.+)$/);
    if (m) return lead + m[1] + '. ' + m[2];
    return line;
  }).join('\n');

  // ---------- tidy ----------
  // Leading space is kept on list lines, where it means nesting, and
  // dropped everywhere else, where it is only Word's indentation.
  h = h.split('\n').map(l => {
    l = l.replace(/[ \t]+$/, (x) => x.length >= 2 ? '  ' : '');
    const list = l.match(/^([ \t]*)([-]|\d{1,2}\.)\s+(.*)$/);
    if (list) {
      // Two spaces per level, which is what the renderer counts.
      const depth = Math.floor(list[1].replace(/\t/g, '  ').length / 2);
      return '  '.repeat(depth) + list[2] + ' ' + list[3];
    }
    return l.replace(/^[ \t]+/, '');
  }).join('\n');

  h = h.replace(/[ \t]{3,}/g, ' ').replace(/\n{3,}/g, '\n\n');

  // A blank line between two list items ends the list, so the renderer
  // would show five one-item lists. Word puts one between every item.
  const isItem = l => /^\s*([-]|\d{1,2}\.)\s/.test(l);
  const lines = h.split('\n');
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() === '' && out.length && isItem(out[out.length - 1])) {
      let j = i;
      while (j < lines.length && lines[j].trim() === '') j++;
      if (j < lines.length && isItem(lines[j])) continue;
    }
    out.push(lines[i]);
  }
  h = out.join('\n').trim();

  return h;
}

// Whatever the message carried, kept as it arrived.
//
// A post stores the plain-text version, which is what is left once a
// mail client has stripped her headings and bold. The HTML version is
// in the same message and holds all of it. Nothing reads this yet — the
// point is to stop throwing it away, so old posts can be rendered
// properly later without asking her to send them again.
function findRaw(payload) {
  const pick = (keys) => {
    for (const k of keys) {
      if (typeof payload[k] === 'string' && payload[k].trim()) return payload[k];
    }
    return null;
  };
  return {
    html: pick(['html', 'body_html', 'htmlBody']),
    text: pick(['plain', 'text', 'body'])
  };
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

// ---------- who may publish ----------
//
// Anything sent to the journal address is published to every approved
// reader, straight away. For a long time nothing checked who sent it: the
// only protection was that the address is a long random string, and
// addresses get harvested. A spam email reaching it would have appeared in
// her journal.
//
// JOURNAL_SENDERS if set, otherwise NOTIFY_TO — the people who coordinate,
// which on Tracey's site already includes her. So an existing site needs
// nothing new configured.
//
// A From address can be forged, so a sender the mail relay reports as
// failing SPF is refused even when the address is on the list. A missing
// result is not treated as a failure: not every relay reports one.
function journalSenderAllowed(payload) {
  const allow = (process.env.JOURNAL_SENDERS || process.env.NOTIFY_TO || '')
    .split(',').map(e => e.trim().toLowerCase()).filter(Boolean);
  if (!allow.length) return { ok: false, who: '' };

  const headers = payload.headers || {};
  const envelope = payload.envelope || {};
  const raw = String(headers.From || headers.from || payload.from || envelope.from || '')
    .toLowerCase();
  const who = (raw.match(/[\w.+-]+@[\w.-]+\.\w+/) || [''])[0];
  if (!who || !allow.includes(who)) return { ok: false, who };

  const spf = String((envelope.spf && envelope.spf.result) || '').toLowerCase();
  if (spf === 'fail') return { ok: false, who: who + ' (SPF failed)' };
  return { ok: true, who };
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

  // Refused with a 200, not an error: an error makes the relay retry, and
  // there is nothing to retry. The log says who it was.
  const sender = journalSenderAllowed(payload);
  if (!sender.ok) {
    console.log('Journal post refused from', sender.who || 'an unknown sender');
    return new Response('Not accepted: sender is not on the journal list', { status: 200 });
  }
  let subject = payload.subject || headers.Subject || headers.subject || '';
  const mailUid = headers['Message-ID'] || headers['Message-Id'] ||
                  headers['message-id'] || payload.message_id || null;

  const raw = findRaw(payload);

  // What she wrote, in order of how much of it survives:
  //   an attached .md or .txt, exactly as she wrote it;
  //   the HTML body, which keeps her headings, bold and lists;
  //   the plain body, which keeps only the words.
  // findMarkdown already prefers an attachment and falls back to the
  // plain body; the HTML sits between them.
  const attached = findAttachment(payload);
  let markdown;
  if (attached) {
    markdown = attached;
  } else if (raw.html) {
    const fromHtml = htmlToMarkdown(raw.html);
    // If conversion somehow produced far less than the plain version,
    // trust the plain one. Losing her words is worse than losing her
    // bold.
    const plainLen = (raw.text || '').replace(/\s+/g, ' ').length;
    markdown = (plainLen && fromHtml.replace(/\s+/g, ' ').length < plainLen * 0.6)
      ? findMarkdown(payload)
      : fromHtml;
  } else {
    markdown = findMarkdown(payload);
  }
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
        p_mail_uid: mailUid,
        // Kept, not used. See findRaw above.
        p_raw_html: raw.html,
        p_raw_text: raw.text
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
