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

const CATEGORIES = ['rides','walks','izzy','errands','other'];

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

// Outlook prefixes the calendar with a VTIMEZONE block that contains its
// own DTSTART entries (the daylight-saving rules, dated 1601 at 02:00).
// Reading those instead of the event's is the difference between the real
// time and nonsense, so isolate the VEVENT before looking at properties.
function eventLines(lines) {
  const start = lines.findIndex(l => /^BEGIN:VEVENT\s*$/i.test(l));
  if (start === -1) return lines;
  let end = lines.findIndex((l, i) => i > start && /^END:VEVENT\s*$/i.test(l));
  if (end === -1) end = lines.length;
  return lines.slice(start + 1, end);
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
  // Fall back to plain-language hints in the title and description.
  // Order matters: Izzy beats walks, so "walk Izzy" is dog help.
  const t = `${title || ''} ${description || ''}`.toLowerCase();

  if (/\b(izzy|dog|puppy|leash|kennel|vet)\b/.test(t)) return 'izzy';

  if (/\bgrocer|\berrand|\bpharmac|\bprescription\b|\bshop|\bstore\b|\bcostco\b|\btarget\b|\bbank\b|\bpost office\b|\blaundry\b|\bdishes\b|\bclean\b|\btidy\b|\byard\b|\blawn\b|\bchores?\b/.test(t))
    return 'errands';

  if (/\bwalk\b|\bstroll\b|\bexercise\b|\bstretch\b/.test(t)) return 'walks';

  if (/\b(rehab|physical therapy|doctor|dr\.|clinic|hospital|medical|appointment|infusion|lab|x-ray|imaging|dentist|specialist)\b/.test(t)
      || /\b(ride|drive|driving|transport|pick ?up|drop ?off)\b/.test(t))
    return 'rides';

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

// Walks the entire payload looking for anything that contains an
// iCalendar body, including base64-encoded attachment content. Outlook
// delivers the calendar as an inline alternative part in some cases and
// as a real attachment in others, so we search everywhere rather than
// guessing which.
function looksLikeBase64(s) {
  return typeof s === 'string' && s.length > 100 &&
         /^[A-Za-z0-9+/=\r\n\s]+$/.test(s);
}

function tryDecode(s) {
  try {
    const out = Buffer.from(s, 'base64').toString('utf8');
    return out.includes('BEGIN:VCALENDAR') ? out : null;
  } catch (e) { return null; }
}

function findCalendarText(payload) {
  const found = [];
  const seen = new Set();

  function walk(node, depth) {
    if (node == null || depth > 8) return;

    if (typeof node === 'string') {
      if (node.includes('BEGIN:VCALENDAR')) { found.push(node); return; }
      if (looksLikeBase64(node)) {
        const decoded = tryDecode(node);
        if (decoded) found.push(decoded);
      }
      return;
    }

    if (Array.isArray(node)) {
      node.forEach(item => walk(item, depth + 1));
      return;
    }

    if (typeof node === 'object') {
      if (seen.has(node)) return;
      seen.add(node);
      Object.keys(node).forEach(k => walk(node[k], depth + 1));
    }
  }

  walk(payload, 0);
  return found.length ? found[0] : null;
}

// Describes what arrived, for troubleshooting when no calendar is found.
function describePayload(payload) {
  const info = { keys: Object.keys(payload || {}) };
  if (Array.isArray(payload.attachments)) {
    info.attachments = payload.attachments.map(a => ({
      name: a.file_name || a.fileName || a.name || null,
      type: a.content_type || a.contentType || null,
      size: a.size || (a.content ? String(a.content).length : null)
    }));
  } else if (payload.attachments) {
    info.attachments = 'present but not an array: ' + typeof payload.attachments;
  } else {
    info.attachments = 'none';
  }
  if (payload.headers && typeof payload.headers === 'object') {
    info.content_type = payload.headers['Content-Type'] ||
                        payload.headers['content-type'] || null;
  }
  return info;
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

  const allLines = unfold(icsText).split(/\r?\n/).map(l => l.trimEnd()).filter(Boolean);
  // METHOD sits on the VCALENDAR envelope, everything else on the VEVENT.
  const lines = eventLines(allLines);

  const methodProp = getProp(allLines, 'METHOD');
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
    p_instructions: stripTags(description),
    // Kept so a claimed need can forward the genuine invitation.
    p_ics: icsText
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
