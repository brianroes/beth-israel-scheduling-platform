// Secure server-side proxy to Jorge Bravo's "Profile Assignments Summary" endpoint.
//
// The upstream API key lives ONLY in the TORAH_API_KEY environment variable on
// Vercel. It is never sent to the browser: the app calls THIS route, and this
// route (running on Vercel's servers) calls the upstream endpoint with the key.
//
// Usage from the app:
//   /api/torah-readings?date=2026-05-30   -> rows for that service date
//   /api/torah-readings                   -> a tiny sample (connectivity/schema check)

const UPSTREAM =
  'https://licpxwbrvyjwcuvcretu.supabase.co/rest/v1/v_profile_assignments_summary';

export default async function handler(req, res) {
  const key = process.env.TORAH_API_KEY;
  if (!key) {
    return res
      .status(500)
      .json({ error: 'Torah API key is not configured on the server.' });
  }

  // Only allow a validated service_date filter, or a small sample for testing.
  const date = (req.query.date || '').toString().trim();
  let query;
  if (date) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return res.status(400).json({ error: 'date must be in YYYY-MM-DD format' });
    }
    query = `?service_date=eq.${date}`;
  } else {
    query = '?limit=3';
  }

  try {
    const upstream = await fetch(UPSTREAM + query, {
      headers: {
        apikey: key,
        Authorization: `Bearer ${key}`,
      },
    });
    const body = await upstream.text();
    res.status(upstream.status);
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    // Brief edge cache so repeated views don't hammer the upstream endpoint.
    res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=600');
    return res.send(body);
  } catch (e) {
    return res.status(502).json({ error: 'Upstream request failed.' });
  }
}
