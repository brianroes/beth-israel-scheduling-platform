// Sync Torah-service fields from Jorge Bravo's database into our own schedule.
//
// Runs two ways:
//   1) Automatically once a day via a Vercel Cron job (see vercel.json).
//   2) On demand from the admin "Sync Torah readings" button.
//
// Server-only secrets (Vercel Environment Variables — never sent to the browser):
//   TORAH_API_KEY              read access to Jorge's endpoint
//   SUPABASE_SERVICE_ROLE_KEY  write access to OUR schedule_data row (bypasses RLS)
//   CRON_SECRET                Vercel sends this as a Bearer token when it runs the cron
//
// Public values (already shipped in index.html, safe to inline):
const OUR_SUPABASE = 'https://ekzvmlicfatqqceorhgz.supabase.co';
const OUR_ANON =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImVrenZtbGljZmF0cXFjZW9yaGd6Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzA3NDIwNjAsImV4cCI6MjA4NjMxODA2MH0.HxULK72tX0gx2Nyo2SU7IaNDejms9UwRS0X1ovdsPU8';
const ADMIN_EMAIL = 'admin@bethisraelnow.com';

const JORGE =
  'https://licpxwbrvyjwcuvcretu.supabase.co/rest/v1/v_profile_assignments_summary';

// Jorge field -> our _svcOrder field
const SVCORDER = [
  ['parasha_transliteration', 'parsha'],
  ['torah_specific_reading', 'torahRef'],
  ['haftarah_specific_reading', 'haftorahRef'],
  ['brit_chadasha_reader', 'britRef'],
];

// Jorge person fields -> our role (matched by role NAME, with aliases)
const PEOPLE = [
  { full: 'cantor_full_name', heb: 'cantor_name_hebrew', roles: ['cantor'] },
  { full: 'torah_reader_full_name', heb: 'torah_reader_name_hebrew', roles: ['torah reader'] },
  { full: 'haftarah_reader_full_name', heb: 'haftarah_reader_name_hebrew', roles: ['haftorah reader', 'haftarah reader'] },
  { full: 'brit_chadasha_reader_full_name', heb: 'brit_chadasha_reader_name_hebrew', roles: ['brit hadashah reader', 'brit chadasha reader', "b'rit hachadasha reader", 'brit hadasha reader'] },
  { full: 'torah_lifter_full_name', heb: 'torah_lifter_name_hebrew', roles: ['torah carrier', 'torah lifter'] },
  { full: 'torah_escort_full_name', heb: 'torah_escort_name_hebrew', roles: ['torah escort', 'torah assistant'] },
];

// "English | Transliteration" — matches the existing convention in the schedule.
function fmtName(full, heb) {
  full = (full || '').toString().trim();
  if (!full) return '';
  let translit = '';
  if (heb) {
    const parts = heb.toString().split(' - ');
    if (parts.length > 1) translit = parts[parts.length - 1].trim();
  }
  return translit ? `${full} | ${translit}` : full;
}

function isCron(req) {
  const secret = process.env.CRON_SECRET;
  return !!secret && req.headers.authorization === `Bearer ${secret}`;
}

async function isAdmin(req) {
  const auth = req.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  if (!token) return false;
  try {
    const r = await fetch(`${OUR_SUPABASE}/auth/v1/user`, {
      headers: { apikey: OUR_ANON, Authorization: `Bearer ${token}` },
    });
    if (!r.ok) return false;
    const u = await r.json();
    return u && u.email === ADMIN_EMAIL;
  } catch (e) {
    return false;
  }
}

export default async function handler(req, res) {
  // Authorize: the Vercel cron (CRON_SECRET) OR a logged-in admin (Supabase token).
  if (!(isCron(req) || (await isAdmin(req)))) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const torahKey = process.env.TORAH_API_KEY;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!torahKey || !serviceKey) {
    return res.status(500).json({
      error: 'Server is missing TORAH_API_KEY or SUPABASE_SERVICE_ROLE_KEY.',
    });
  }

  const today = new Date().toISOString().slice(0, 10);

  // 1) Pull all upcoming readings from Jorge.
  let jorgeRows;
  try {
    const jr = await fetch(`${JORGE}?service_date=gte.${today}&order=service_date.asc`, {
      headers: { apikey: torahKey, Authorization: `Bearer ${torahKey}` },
    });
    if (!jr.ok) return res.status(502).json({ error: 'Jorge endpoint error', status: jr.status });
    jorgeRows = await jr.json();
  } catch (e) {
    return res.status(502).json({ error: 'Could not reach Jorge endpoint.' });
  }

  // 2) Read our current schedule row (service role bypasses RLS).
  let data;
  let baseUpdatedAt;
  try {
    const rr = await fetch(`${OUR_SUPABASE}/rest/v1/schedule_data?id=eq.1&select=data,updated_at`, {
      headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` },
    });
    if (!rr.ok) return res.status(502).json({ error: 'Could not read schedule row', status: rr.status });
    const rows = await rr.json();
    data = rows && rows[0] && rows[0].data;
    baseUpdatedAt = rows && rows[0] && rows[0].updated_at;
  } catch (e) {
    return res.status(502).json({ error: 'Could not read schedule row.' });
  }
  if (!data || !data.schedule) return res.status(500).json({ error: 'Schedule data is empty.' });

  // Build role-name -> id lookup from current roles.
  const roleIdByName = {};
  (data.roles || []).forEach((r) => {
    roleIdByName[(r.n || '').trim().toLowerCase()] = r.id;
  });
  const findRoleId = (aliases) => {
    for (const a of aliases) if (roleIdByName[a]) return roleIdByName[a];
    return null;
  };

  // 3) Merge Jorge's fields into matching upcoming dates (only dates we already have).
  const updatedDates = [];
  const missingDates = [];
  let changes = 0;

  for (const row of jorgeRows || []) {
    const date = row.service_date;
    if (!date) continue;
    if (!data.schedule[date]) {
      missingDates.push(date);
      continue;
    }
    const svc = data.schedule[date];
    let touched = false;

    if (!svc._svcOrder) {
      svc._svcOrder = { msgTitle: '', parsha: '', torahRef: '', haftorahRef: '', britRef: '', seudat: false, kaddish: false };
    }
    for (const [src, dst] of SVCORDER) {
      const v = (row[src] || '').toString().trim();
      if (v && svc._svcOrder[dst] !== v) {
        svc._svcOrder[dst] = v;
        touched = true;
        changes++;
      }
    }
    for (const p of PEOPLE) {
      const name = fmtName(row[p.full], row[p.heb]);
      if (!name) continue;
      const rid = findRoleId(p.roles);
      if (!rid) continue;
      const cur = Array.isArray(svc[rid]) ? svc[rid] : [];
      if (cur.length !== 1 || cur[0] !== name) {
        svc[rid] = [name];
        touched = true;
        changes++;
      }
    }
    if (touched) updatedDates.push(date);
  }

  // 4) Write back only if something actually changed.
  if (changes > 0) {
    try {
      const newUpdatedAt = new Date().toISOString();
      const wr = await fetch(
        `${OUR_SUPABASE}/rest/v1/schedule_data?id=eq.1&updated_at=eq.${encodeURIComponent(baseUpdatedAt)}`,
        {
          method: 'PATCH',
          headers: {
            apikey: serviceKey,
            Authorization: `Bearer ${serviceKey}`,
            'Content-Type': 'application/json',
            Prefer: 'return=representation',
          },
          body: JSON.stringify({ data, updated_at: newUpdatedAt }),
        }
      );
      if (!wr.ok) return res.status(502).json({ error: 'Could not write schedule row', status: wr.status });
      const written = await wr.json();
      if (!Array.isArray(written) || !written.length) {
        return res.status(409).json({
          error: 'Schedule changed during sync. Please run sync again.',
        });
      }
    } catch (e) {
      return res.status(502).json({ error: 'Could not write schedule row.' });
    }
  }

  return res.status(200).json({
    ok: true,
    upcomingFromJorge: (jorgeRows || []).length,
    datesUpdated: updatedDates,
    fieldsChanged: changes,
    datesJorgeHasThatYouDont: missingDates,
  });
}
