// Serves a photograph from one of Tracey's posts.
//
// The picture is embedded in the post rather than linked, but every
// picture still has an address behind it. This is that address, and it
// checks who is asking: somebody she has let in gets the photograph,
// anybody else gets nothing. Copying the address and passing it on is
// therefore worth exactly as much as passing on the page, which is the
// same bargain her writing already makes.
//
// A public bucket would have been simpler and would have handed out an
// address that works for anyone who has it, forever.

export default async (request) => {
  const { SUPABASE_URL, SUPABASE_KEY } = process.env;
  if (!SUPABASE_URL || !SUPABASE_KEY) {
    return new Response('Not configured', { status: 500 });
  }

  const url = new URL(request.url);
  const id = url.searchParams.get('id');
  const who = url.searchParams.get('as');
  const pass = url.searchParams.get('pass');
  if (!id || (!who && !pass)) return new Response('Not found', { status: 404 });

  // Two ways of being allowed: a reader identified by email, or Tracey
  // and the coordinators by passphrase on their own pages. The second
  // exists because those pages have no registration behind them.
  const fn = pass ? 'get_photo_by_pass' : 'get_photo';
  const body = pass ? { p_pass: pass, p_id: id } : { p_email: who, p_id: id };

  try {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${fn}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': SUPABASE_KEY,
        'Authorization': `Bearer ${SUPABASE_KEY}`
      },
      body: JSON.stringify(body)
    });
    if (!res.ok) return new Response('Not found', { status: 404 });

    const out = JSON.parse(await res.text());
    if (!out || out.ok !== true) {
      // Deliberately the same answer as a photograph that does not
      // exist. "You are not allowed this one" tells somebody there is
      // something here to be allowed.
      return new Response('Not found', { status: 404 });
    }

    const bytes = Uint8Array.from(atob(out.bytes), c => c.charCodeAt(0));
    return new Response(bytes, {
      status: 200,
      headers: {
        'Content-Type': out.mime,
        // Cached briefly, and keyed on the whole address — which
        // includes who is asking. So a stored copy is only ever handed
        // back to the person it was made for, including by the edge
        // resizer in front of this.
        'Cache-Control': pass ? 'private, no-store' : 'public, max-age=600',
        'Vary': 'Accept',
        'Content-Disposition': 'inline'
      }
    });
  } catch (e) {
    console.error('Could not serve the photo', e);
    return new Response('Not found', { status: 404 });
  }
};

export const config = { path: '/api/photo' };
