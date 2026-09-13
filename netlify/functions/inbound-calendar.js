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

// An appointment that needs a lift each way. Tagged once, it becomes two
// needs: a ride there at the start time, a ride home at the end.
const ROUNDTRIP_RE = /#(roundtrip|bothways|ride2)\b/i;

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
  out = out.replace(ROUNDTRIP_RE, '');
  return out.replace(/\s{2,}/g, ' ').trim();
}


// ---------- repeat rules ------------------------------------------------

// How far ahead a repeating event is expanded. Far enough that friends
// can plan, short enough that a daily walk does not fill the page with
// months of entries. Re-sending the invitation extends the window.
// Twelve weeks ahead, but no more than thirty entries from one series.
// A daily walk would otherwise put eighty-five rows on the page and bury
// everything else. Re-sending the invitation rolls the window forward.
const RECUR_DAYS = 84;
const RECUR_MAX = 30;

const DAY_CODES = { SU:0, MO:1, TU:2, WE:3, TH:4, FR:5, SA:6 };

function ymd(d) {
  return d.getUTCFullYear() + '-' +
         String(d.getUTCMonth() + 1).padStart(2, '0') + '-' +
         String(d.getUTCDate()).padStart(2, '0');
}

// Parses RRULE:FREQ=WEEKLY;BYDAY=MO,TH;UNTIL=... into a plain object.
function parseRule(value) {
  const out = {};
  String(value || '').split(';').forEach(part => {
    const eq = part.indexOf('=');
    if (eq > 0) out[part.slice(0, eq).toUpperCase()] = part.slice(eq + 1);
  });
  return out;
}

// Dates are handled in UTC throughout. The event's wall-clock time is
// carried separately as a display string, so no conversion is involved
// and daylight saving cannot shift anything.
function expandRecurrence(ruleValue, startDate, exdates) {
  const rule = parseRule(ruleValue);
  const freq = (rule.FREQ || '').toUpperCase();
  if (!freq) return null;

  const interval = Math.max(1, parseInt(rule.INTERVAL || '1', 10) || 1);
  const count = rule.COUNT ? parseInt(rule.COUNT, 10) : null;

  let until = null;
  if (rule.UNTIL) {
    const m = String(rule.UNTIL).match(/^(\d{4})(\d{2})(\d{2})/);
    if (m) until = Date.UTC(+m[1], +m[2] - 1, +m[3], 23, 59, 59);
  }

  const [sy, sm, sd] = startDate.split('-').map(Number);
  const start = new Date(Date.UTC(sy, sm - 1, sd));

  const horizon = Date.now() + RECUR_DAYS * 86400000;
  const skip = new Set(exdates || []);
  const dates = [];

  function add(d) {
    const key = ymd(d);
    if (skip.has(key)) return true;          // excluded, but still counts
    if (dates.indexOf(key) === -1) dates.push(key);
    return true;
  }

  if (freq === 'WEEKLY') {
    const days = (rule.BYDAY || '')
      .split(',')
      .map(x => DAY_CODES[x.trim().slice(-2).toUpperCase()])
      .filter(x => x !== undefined);
    if (!days.length) days.push(start.getUTCDay());

    // Start from the Sunday of the first week so BYDAY lands correctly.
    const weekStart = new Date(start);
    weekStart.setUTCDate(weekStart.getUTCDate() - weekStart.getUTCDay());

    let emitted = 0;
    for (let w = 0; w < 260; w++) {
      const base = new Date(weekStart);
      base.setUTCDate(base.getUTCDate() + w * 7 * interval);
      if (base.getTime() > horizon + 7 * 86400000) break;

      for (const dow of days.slice().sort((a, b) => a - b)) {
        const d = new Date(base);
        d.setUTCDate(d.getUTCDate() + dow);
        if (d.getTime() < start.getTime()) continue;
        if (until && d.getTime() > until) return dates;
        if (d.getTime() > horizon) return dates;
        add(d);
        emitted++;
        if (count && emitted >= count) return dates;
        if (dates.length >= RECUR_MAX) return dates;
      }
    }
    return dates;
  }

  if (freq === 'DAILY') {
    let emitted = 0;
    for (let i = 0; i < 400; i++) {
      const d = new Date(start);
      d.setUTCDate(d.getUTCDate() + i * interval);
      if (until && d.getTime() > until) break;
      if (d.getTime() > horizon) break;
      add(d);
      emitted++;
      if (count && emitted >= count) break;
      if (dates.length >= RECUR_MAX) break;
    }
    return dates;
  }

  if (freq === 'MONTHLY') {
    const dayOfMonth = rule.BYMONTHDAY
      ? parseInt(rule.BYMONTHDAY, 10) : start.getUTCDate();
    let emitted = 0;
    for (let i = 0; i < 60; i++) {
      const d = new Date(Date.UTC(sy, sm - 1 + i * interval, dayOfMonth));
      // Skip months with no such day, e.g. the 31st of February.
      if (d.getUTCDate() !== dayOfMonth) continue;
      if (d.getTime() < start.getTime()) continue;
      if (until && d.getTime() > until) break;
      if (d.getTime() > horizon) break;
      add(d);
      emitted++;
      if (count && emitted >= count) break;
      if (dates.length >= RECUR_MAX) break;
    }
    return dates;
  }

  // Yearly and anything unusual: treat as a single event rather than
  // guessing. One correct need beats a page of wrong ones.
  return null;
}

// EXDATE lines may list several dates, and there may be several lines.
function collectExdates(lines) {
  const out = [];
  for (const line of lines) {
    const colon = line.indexOf(':');
    if (colon === -1) continue;
    const key = line.slice(0, colon).split(';')[0].trim().toUpperCase();
    if (key !== 'EXDATE') continue;
    line.slice(colon + 1).split(',').forEach(v => {
      const m = v.trim().match(/^(\d{4})(\d{2})(\d{2})/);
      if (m) out.push(`${m[1]}-${m[2]}-${m[3]}`);
    });
  }
  return out;
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

  // A repeating event arrives as one invitation carrying a rule. A single
  // changed occurrence arrives separately, carrying RECURRENCE-ID.
  const ruleProp = getProp(lines, 'RRULE');
  const recurIdProp = getProp(lines, 'RECURRENCE-ID');

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

  // ---------- a changed single occurrence ----------
  // Key it to the occurrence it replaces, so it updates that need rather
  // than creating a stray one.
  let effectiveUid = uid;
  if (recurIdProp) {
    const m = String(recurIdProp.value).trim().match(/^(\d{4})(\d{2})(\d{2})/);
    if (m) effectiveUid = uid + '::' + m[1] + m[2] + m[3];
  }

  const isRoundTrip = ROUNDTRIP_RE.test(summary) || ROUNDTRIP_RE.test(description);

  // ---------- an appointment needing a lift each way ----------
  // Handled before the series branch, because a repeating appointment
  // needs a pair for every occurrence.
  if (isRoundTrip) {
    const dates = (ruleProp && !recurIdProp)
      ? (expandRecurrence(ruleProp.value, start.date, collectExdates(lines)) || [start.date])
      : [start.date];

    if (effectiveMethod === 'CANCEL') {
      const bases = dates.map(d => (ruleProp ? uid + '::' + d.replace(/-/g, '') : effectiveUid));
      let total = 0;
      for (const base of bases) {
        try {
          const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/cancel_pair`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'apikey': SUPABASE_KEY,
              'Authorization': `Bearer ${SUPABASE_KEY}`
            },
            body: JSON.stringify({ p_token: INGEST_TOKEN, p_base_uid: base })
          });
          if (res.ok) total++;
        } catch (e) { console.error('Could not cancel a pair', e); }
      }
      console.log('Cancelled round trips:', total);
      return new Response(JSON.stringify({ action: 'pairs_cancelled', count: total }), {
        status: 200, headers: { 'Content-Type': 'application/json' }
      });
    }

    let made = 0;
    const problems = [];
    for (const d of dates) {
      const base = ruleProp ? uid + '::' + d.replace(/-/g, '') : effectiveUid;
      try {
        const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/ingest_pair`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'apikey': SUPABASE_KEY,
            'Authorization': `Bearer ${SUPABASE_KEY}`
          },
          body: JSON.stringify({
            p_token: INGEST_TOKEN,
            p_base_uid: base,
            p_sequence: sequence,
            p_title: stripTags(summary),
            p_category: 'rides',
            p_location: location,
            p_instructions: stripTags(description),
            p_ics: icsText,
            p_date: d,
            p_start: start.time,
            p_end: end ? end.time : start.time
          })
        });
        if (res.ok) made++;
        else problems.push((await res.text()).slice(0, 160));
      } catch (e) {
        problems.push(String(e && e.message ? e.message : e).slice(0, 120));
      }
    }

    if (!made) {
      return new Response(JSON.stringify({
        error: 'database rejected the round trip',
        detail: problems.slice(0, 2)
      }), { status: 502, headers: { 'Content-Type': 'application/json' } });
    }

    console.log('Round trips stored:', stripTags(summary), made, 'appointment(s)');
    return new Response(JSON.stringify({
      action: 'round_trip', appointments: made, needs: made * 2,
      failed: problems.length
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }

  // ---------- the whole series ----------
  if (ruleProp && !recurIdProp) {
    if (effectiveMethod === 'CANCEL') {
      try {
        const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/cancel_series`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'apikey': SUPABASE_KEY,
            'Authorization': `Bearer ${SUPABASE_KEY}`
          },
          body: JSON.stringify({ p_token: INGEST_TOKEN, p_base_uid: uid })
        });
        const txt = await res.text();
        console.log('Cancelled series', uid.slice(0, 40), txt);
        return new Response(txt, {
          status: res.ok ? 200 : 502,
          headers: { 'Content-Type': 'application/json' }
        });
      } catch (e) {
        console.error('Could not cancel the series', e);
        return new Response('Upstream unreachable', { status: 502 });
      }
    }

    const dates = expandRecurrence(
      ruleProp.value, start.date, collectExdates(lines));

    if (dates && dates.length) {
      const occurrences = dates.map(d => ({
        date: d,
        start: start.time,
        end: end ? end.time : start.time
      }));

      try {
        const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/ingest_series`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'apikey': SUPABASE_KEY,
            'Authorization': `Bearer ${SUPABASE_KEY}`
          },
          body: JSON.stringify({
            p_token: INGEST_TOKEN,
            p_base_uid: uid,
            p_sequence: sequence,
            p_title: stripTags(summary),
            p_category: category,
            p_location: location,
            p_instructions: stripTags(description),
            p_ics: icsText,
            p_occurrences: occurrences
          })
        });
        const txt = await res.text();
        if (!res.ok) {
          console.error('Series rejected:', res.status, txt);
          return new Response(JSON.stringify({
            error: 'database rejected the series',
            status: res.status,
            detail: txt.slice(0, 400),
            sent: { uid: uid.slice(0, 60), occurrences: occurrences.length,
                    first: occurrences[0], last: occurrences[occurrences.length - 1] }
          }), { status: 502, headers: { 'Content-Type': 'application/json' } });
        }
        console.log('Series stored:', stripTags(summary), occurrences.length, 'occurrences');
        return new Response(txt, {
          status: 200, headers: { 'Content-Type': 'application/json' }
        });
      } catch (e) {
        console.error('Supabase unreachable', e);
        return new Response('Upstream unreachable', { status: 502 });
      }
    }
    // An unusual rule we do not expand falls through and becomes one need.
  }

  const body = {
    p_token: INGEST_TOKEN,
    p_uid: effectiveUid,
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
      // Surface the reason in the reply so it shows on the CloudMailin
      // message details page, rather than only in the function logs.
      return new Response(JSON.stringify({
        error: 'database rejected the event',
        status: res.status,
        detail: text.slice(0, 400),
        sent: {
          uid: uid.slice(0, 60),
          title: body.p_title,
          category: body.p_category,
          date: body.p_date,
          start: body.p_start,
          end: body.p_end,
          method: effectiveMethod,
          ics_bytes: icsText.length
        }
      }), { status: 502, headers: { 'Content-Type': 'application/json' } });
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
