/**
 * POST /api/apply
 *
 * Receives a partner application from apply.html and stores it in Postgres.
 *
 * Environment (set in Vercel → Project → Settings → Environment Variables):
 *   DATABASE_URL   Postgres connection string. Vercel's Neon integration sets
 *                  DATABASE_URL / POSTGRES_URL automatically when you attach a
 *                  database to the project — either name works.
 *
 * If no database is configured (or the insert fails) the submission is still
 * accepted and written to the function log as a single JSON line prefixed with
 * "APPLICATION_FALLBACK" so nothing is ever silently lost. Look for it under
 * Vercel → Project → Logs.
 */

import { neon } from '@neondatabase/serverless';

const CONNECTION_STRING =
  process.env.DATABASE_URL ||
  process.env.POSTGRES_URL ||
  process.env.POSTGRES_URL_NON_POOLING ||
  '';

/* Fields we accept. Anything else in the payload is ignored. */
const FIELDS = [
  'firstName',
  'lastName',
  'email',
  'phone',
  'state',
  'licensed',
  'experience',
  'federalExperience',
  'timeline',
  'notes',
  'consent',
  'page'
];

const MAX_LENGTH = {
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
  consent: 10,
  page: 200
};

let schemaReady = false;

async function ensureSchema(sql) {
  if (schemaReady) return;
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
  schemaReady = true;
}

function clean(value, limit) {
  if (typeof value !== 'string') return '';
  return value.trim().slice(0, limit);
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  let payload = req.body;
  if (typeof payload === 'string') {
    try {
      payload = JSON.parse(payload);
    } catch {
      return res.status(400).json({ error: 'Invalid JSON body' });
    }
  }
  if (!payload || typeof payload !== 'object') {
    return res.status(400).json({ error: 'Missing body' });
  }

  /* Honeypot — real people never fill this in. Accept quietly, store nothing. */
  if (clean(payload.company, 200)) {
    return res.status(200).json({ ok: true });
  }

  const data = {};
  for (const field of FIELDS) {
    data[field] = clean(payload[field], MAX_LENGTH[field] || 250);
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

  if (!CONNECTION_STRING) {
    console.warn(
      'APPLICATION_FALLBACK ' +
        JSON.stringify({ reason: 'no DATABASE_URL configured', ...data, ip })
    );
    return res.status(200).json({ ok: true, stored: false });
  }

  try {
    const sql = neon(CONNECTION_STRING);
    await ensureSchema(sql);
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
    return res.status(200).json({ ok: true, stored: true, id: rows[0].id });
  } catch (err) {
    /* Never lose a lead to a database problem — log it and accept. */
    console.error('APPLICATION_FALLBACK ' + JSON.stringify({ reason: String(err), ...data, ip }));
    return res.status(200).json({ ok: true, stored: false });
  }
}
