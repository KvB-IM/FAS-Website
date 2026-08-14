// POST /api/apply — partner agent application intake.
//
// Stores each submission in Postgres (Neon). Mirrors the conventions used by
// the FB-Website API: CommonJS, POSTGRES_URL || DATABASE_URL, and a database
// failure is never allowed to lose a lead.
//
// Environment (Vercel → Project → Settings → Environment Variables):
//   POSTGRES_URL / DATABASE_URL   Neon connection string. Vercel's Neon
//                                 integration sets both automatically.
//
// If the database is unreachable the submission is still accepted and written
// to the function log as one JSON line prefixed "APPLICATION_FALLBACK", so it
// can always be recovered from Vercel → Project → Logs.
const { neon } = require('@neondatabase/serverless');

function getDb() {
  const connectionString = process.env.POSTGRES_URL || process.env.DATABASE_URL;
  if (!connectionString) {
    console.warn('No POSTGRES_URL or DATABASE_URL configured.');
    return null;
  }
  return neon(connectionString);
}

// Accepted fields, with the maximum length stored for each.
const FIELDS = {
  firstName: 120,
  lastName: 120,
  email: 250,
  phone: 60,
  state: 80,
  licensed: 120,
  experience: 60,
  federalExperience: 120,
  timeline: 60,
  notes: 4000,
  page: 200
};

let tableReady = false;

async function ensureTable(sql) {
  if (tableReady) return;
  await sql`
    CREATE TABLE IF NOT EXISTS partner_applications (
      id                 BIGSERIAL PRIMARY KEY,
      created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      first_name         TEXT NOT NULL,
      last_name          TEXT NOT NULL,
      email              TEXT NOT NULL,
      phone              TEXT NOT NULL,
      state              TEXT,
      licensed           TEXT,
      experience         TEXT,
      federal_experience TEXT,
      timeline           TEXT,
      notes              TEXT,
      consent            BOOLEAN NOT NULL DEFAULT FALSE,
      source_page        TEXT,
      ip                 TEXT,
      user_agent         TEXT
    )
  `;
  await sql`
    CREATE INDEX IF NOT EXISTS partner_applications_created_at_idx
      ON partner_applications (created_at DESC)
  `;
  tableReady = true;
}

function clean(value, limit) {
  if (typeof value !== 'string') return '';
  return value.trim().slice(0, limit);
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  let payload = req.body;
  if (typeof payload === 'string') {
    try {
      payload = JSON.parse(payload);
    } catch (err) {
      return res.status(400).json({ error: 'Invalid JSON body' });
    }
  }
  if (!payload || typeof payload !== 'object') {
    return res.status(400).json({ error: 'Missing body' });
  }

  // Honeypot — real people never fill this in. Accept quietly, store nothing.
  if (clean(payload.company, 200)) {
    return res.status(200).json({ ok: true });
  }

  const data = {};
  for (const field of Object.keys(FIELDS)) {
    data[field] = clean(payload[field], FIELDS[field]);
  }

  const missing = ['firstName', 'lastName', 'email', 'phone'].filter((f) => !data[f]);
  if (missing.length) {
    return res.status(400).json({ error: 'Missing required fields: ' + missing.join(', ') });
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(data.email)) {
    return res.status(400).json({ error: 'Please enter a valid email address.' });
  }
  if (payload.consent !== 'yes' && payload.consent !== true) {
    return res.status(400).json({ error: 'Please agree to be contacted before submitting.' });
  }

  const forwarded = req.headers['x-forwarded-for'];
  const ip = (Array.isArray(forwarded) ? forwarded[0] : forwarded || '').split(',')[0].trim();
  const userAgent = clean(req.headers['user-agent'], 400);

  // Only ever called when the row could not be stored. It deliberately writes
  // the applicant's details to the log — that is the recovery copy — so it must
  // not be used on the success path, where the same data would be PII in logs
  // for no reason.
  const fallback = (reason) =>
    console.error('APPLICATION_FALLBACK ' + JSON.stringify(Object.assign({ reason: reason }, data, { ip: ip })));

  const sql = getDb();
  if (!sql) {
    fallback('no POSTGRES_URL or DATABASE_URL configured');
    return res.status(200).json({ ok: true, stored: false });
  }

  try {
    await ensureTable(sql);
    const rows = await sql`
      INSERT INTO partner_applications
        (first_name, last_name, email, phone, state, licensed, experience,
         federal_experience, timeline, notes, consent, source_page, ip, user_agent)
      VALUES
        (${data.firstName}, ${data.lastName}, ${data.email}, ${data.phone},
         ${data.state || null}, ${data.licensed || null}, ${data.experience || null},
         ${data.federalExperience || null}, ${data.timeline || null},
         ${data.notes || null}, TRUE, ${data.page || null},
         ${ip || null}, ${userAgent || null})
      RETURNING id
    `;
    console.log('Partner application stored, id=' + rows[0].id);
    return res.status(200).json({ ok: true, stored: true, id: rows[0].id });
  } catch (err) {
    // A database problem must never cost us the lead.
    fallback(err.message);
    return res.status(200).json({ ok: true, stored: false });
  }
};
