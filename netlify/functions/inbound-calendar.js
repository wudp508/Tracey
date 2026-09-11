// Receives an Outlook meeting invite by email and turns it into a need.
//
// CloudMailin posts the message here. We pull out the text/calendar part,
// parse it, and hand the details to Supabase.
//
// No npm packages — Netlify's Node runtime has everything we use.
//
// Environment variables required (set in Netlify, not in this file):
//   SUPABASE_URL        your project URL
//   SUPABASE_KEY        the sb_publishable_ key
//   INGEST_TOKEN        must match settings.ingest_token in Supabase
//   TIMEZONE            optional IANA zone, e.g. America/New_York

const CATEGORIES = ['rehab','medical','walk','social','outing',
                    'dog','errands','household','other'];

// ---------- iCalendar parsing ----------------------------------------

// ICS folds long lines by starting continuations with a space or tab.
function unfold(text) {
  return text.replace(/\r\n[ \t]/g, '').replace(/\n[ \t]/g, '');
}

function unescapeText(v) {
  return String(v || '')
    .replace(/\\n/gi, '\n')
    .replace(/\\,/g, ',')
    .replace(/\\;/g, ';')
    .replace(/\\\\/g, '\\')
    .trim();
}

// Returns { value, params } for the first occurrence of a property.
function getProp(lines, name) {
  const upper = name.toUpperCase();
  for (const line of lines) {
    const colon = line.indexOf(':');
    if (colon === -1) continue;
    const left = line.slice(0, colon);
    const key = left.split(';')[0].trim().toUpperCase();
    if (key !== upper) continue;
    const params = {};
    left.split(';').slice(1).forEach(p => {
      const eq = p.indexOf('=');
      if (eq > -1) params[p.slice(0, eq).toUpperCase()] = p.slice(eq + 1).replace(/^"|"$/g, '');
    });
    return { value: line.slice(colon + 1), params };
  }
  return null;
}

// Handles both floating/TZID local times (20260915T084500) and UTC (…Z).
// Returns { date: 'YYYY-MM-DD', time: '8:45 AM' } or null.
function parseDateTime(prop, tz) {
  if (!prop) return null;
  const raw = String(prop.value || '').trim();
  const m = raw.match(/^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?$/);
  if (!m) return null;

  const [, y, mo, d, hh, mm, , isUtc] = m;

  // Date-only (all-day event)
  if (hh === undefined) {
    return { date: `${y}-${mo}-${d}`, time: 'All day' };
  }

  if (isUtc) {
    // Convert UTC to the configured local zone.
    const dt = new Date(Date.UTC(+y, +mo - 1, +d, +hh, +mm, 0));
    try {
      const parts = new Intl.DateTimeFormat('en-US', {
        timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
        hour: 'numeric', minute: '2-digit', hour12: true
      }).formatToParts(dt);
      const get = t => (parts.find(p => p.type === t) || {}).value;
      const hour = get('hour');
      const minute = get('minute');
      const period = (get('dayPeriod') || '').toUpperCase();
      return {
        date: `${get('year')}-${get('month')}-${get('day')}`,
        time: `${hour}:${minute} ${period}`
      };
    } catch (e) {
      // Fall through to treating it as local if the zone is unusable.
    }
  }

  // Local / TZID time — use the wall-clock values as written.
  let hour12 = +hh % 12; if (hour12 === 0) hour12 = 12;
  const period = +hh < 12 ? 'AM' : 'PM';
  return { date: `${y}-${mo}-${d}`, time: `${hour12}:${mm} ${period}` };
}

// A #tag anywhere in the title or description sets the category.
function extractCategory(title, description) {
  const hay = `${title || ''} ${description || ''}`.toLowerCase();
  for (const cat of CATEGORIES) {
    if (hay.includes('#' + cat)) return cat;
  }
  // Fall back to a few plain-language hints in the title.
  const t = (title || '').toLowerCase();
  if (/\brehab\b/.test(t)) return 'rehab';
  if (/\b(doctor|clinic|appointment|medical)\b/.test(t)) return 'medical';
  if (/\bwalk\b/.test(t)) return 'walk';
  if (/\b(grocer|errand|pharmacy|shopping)\b/.test(t)) return 'errands';
  if (/\b(visit|coffee|lunch|dinner)\b/.test(t)) return 'social';
  if (/\b(izzy|dog)\b/.test(t)) return 'dog';
  return 'other';
}

function stripTags(text) {
  let out = String(text || '');
  CATEGORIES.forEach(c => {
    out = out.replace(new RegExp('#' + c, 'gi'), '');
  });
  return out.replace(/\s{2,}/g, ' ').trim();
}

// ---------- finding the calendar part in the email --------------------

function findCalendarText(payload) {
  // CloudMailin JSON format: attachments carry content + content_type.
  const candidates = [];

  if (Array.isArray(payload.attachments)) {
    payload.attachments.forEach(a => {
      const type = (a.content_type || a.contentType || '').toLowerCase();
      const name = (a.file_name || a.fileName || '').toLowerCase();
      if (type.includes('text/calendar') || name.endsWith('.ics')) {
        let content = a.content || '';
        if ((a.content_transfer_encoding || '').toLowerCase() === 'base64' ||
            /^[A-Za-z0-9+/=\s]+$/.test(content) && content.length > 200 &&
            !content.includes('BEGIN:VCALENDAR')) {
          try { content = Buffer.from(content, 'base64').toString('utf8'); } catch (e) {}
        }
        candidates.push(content);
      }
    });
  }

  // Some setups deliver the calendar as the plain or html body.
  ['plain', 'html', 'text', 'body'].forEach(k => {
    if (typeof payload[k] === 'string') candidates.push(payload[k]);
  });

  // Raw MIME fallback.
  if (typeof payload.raw === 'string') candidates.push(payload.raw);

  for (const c of candidates) {
    if (c && c.includes('BEGIN:VCALENDAR')) return c;
  }
  return null;
}

// ---------- handler ---------------------------------------------------

export default async (request) => {
  if (request.method !== 'POST') {
    return new Response('Method not allowed', { status: 405 });
  }

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_KEY = process.env.SUPABASE_KEY;
  const INGEST_TOKEN = process.env.INGEST_TOKEN;
  const TZ = process.env.TIMEZONE || 'America/New_York';

  if (!SUPABASE_URL || !SUPABASE_KEY || !INGEST_TOKEN) {
    console.error('Missing environment variables');
    return new Response('Server not configured', { status: 500 });
  }

  let payload;
  try {
    const contentType = (request.headers.get('content-type') || '').toLowerCase();
    if (contentType.includes('application/json')) {
      payload = await request.json();
    } else {
      // multipart or urlencoded
      const form = await request.formData();
      payload = {};
      for (const [k, v] of form.entries()) {
        if (typeof v === 'string') {
          payload[k] = v;
        } else {
          payload.attachments = payload.attachments || [];
          payload.attachments.push({
            content_type: v.type,
            file_name: v.name,
            content: await v.text()
          });
        }
      }
    }
  } catch (e) {
    console.error('Could not read request body', e);
    return new Response('Bad request', { status: 400 });
  }

  const icsText = findCalendarText(payload);
  if (!icsText) {
    // Not a calendar invite. Accept it so the sender does not get a bounce.
    console.log('No calendar part found; ignoring message');
    return new Response('No calendar content', { status: 200 });
  }

  const lines = unfold(icsText).split(/\r?\n/).map(l => l.trimEnd()).filter(Boolean);

  const methodProp = getProp(lines, 'METHOD');
  const method = methodProp ? String(methodProp.value).trim().toUpperCase() : 'REQUEST';

  const uidProp = getProp(lines, 'UID');
  if (!uidProp) {
    console.log('Calendar part has no UID; ignoring');
    return new Response('No UID', { status: 200 });
  }
  const uid = String(uidProp.value).trim();

  const seqProp = getProp(lines, 'SEQUENCE');
  const sequence = seqProp ? parseInt(String(seqProp.value).trim(), 10) || 0 : 0;

  const statusProp = getProp(lines, 'STATUS');
  const icsStatus = statusProp ? String(statusProp.value).trim().toUpperCase() : '';
  const effectiveMethod = (method === 'CANCEL' || icsStatus === 'CANCELLED')
    ? 'CANCEL' : 'REQUEST';

  const summary = unescapeText(getProp(lines, 'SUMMARY')?.value);
  const location = unescapeText(getProp(lines, 'LOCATION')?.value);
  let description = unescapeText(getProp(lines, 'DESCRIPTION')?.value);

  // Outlook appends a join-link block to the description. Trim it.
  description = description
    .split(/_{10,}/)[0]
    .split(/Microsoft Teams (?:meeting|Need help)/i)[0]
    .trim();

  const start = parseDateTime(getProp(lines, 'DTSTART'), TZ);
  const end = parseDateTime(getProp(lines, 'DTEND'), TZ);

  if (!start && effectiveMethod !== 'CANCEL') {
    console.log('Could not parse a start time; ignoring');
    return new Response('No usable start time', { status: 200 });
  }

  const category = extractCategory(summary, description);

  const body = {
    p_token: INGEST_TOKEN,
    p_uid: uid,
    p_sequence: sequence,
    p_method: effectiveMethod,
    p_title: stripTags(summary),
    p_category: category,
    p_date: start ? start.date : '1970-01-01',
    p_start: start ? start.time : '',
    p_end: end ? end.time : (start ? start.time : ''),
    p_location: location,
    p_instructions: stripTags(description)
  };

  try {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/ingest_event`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': SUPABASE_KEY,
        'Authorization': `Bearer ${SUPABASE_KEY}`
      },
      body: JSON.stringify(body)
    });

    const text = await res.text();
    if (!res.ok) {
      console.error('Supabase rejected the event:', res.status, text);
      return new Response('Upstream error', { status: 502 });
    }
    console.log('Ingested', uid, text);
    return new Response(text, {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });
  } catch (e) {
    console.error('Could not reach Supabase', e);
    return new Response('Upstream unreachable', { status: 502 });
  }
};

export const config = { path: '/api/inbound-calendar' };

