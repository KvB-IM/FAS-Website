// POST /api/apply — partner agent application intake.
//
// Two destinations, in a deliberate order:
//
//   1. Neon Postgres — the system of record. Written first, and the response
//      the applicant sees depends only on this step.
//   2. Zoho CRM ("FB Leads" module) — a mirror for the sales team. Attempted
//      after the row is safe, and a failure here is recorded, not raised.
//
// Mirrors the conventions used by the FB-Website API: CommonJS,
// POSTGRES_URL || DATABASE_URL, and a storage failure is never allowed to lose
// a lead.
//
// Environment (Vercel → Project → Settings → Environment Variables):
//   POSTGRES_URL / DATABASE_URL   Neon connection string. Vercel's Neon
//                                 integration sets both automatically.
//   ZOHO_*                        See api/_zoho.js. When these are unset the
//                                 CRM step is skipped and Neon behaves exactly
//                                 as it did before.
//
// If the database is unreachable the submission is still accepted and written
// to the function log as one JSON line prefixed "APPLICATION_FALLBACK", so it
// can always be recovered from Vercel → Project → Logs. If Neon fails *and*
// the CRM push fails, the same line is the only copy — that is why it is still
// written even when Zoho is configured.
const { neon } = require('@neondatabase/serverless');
const zoho = require('./_zoho');

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
let crmColumnsReady = false;

// Everything needed to store an application, and nothing else. Deliberately
// unchanged from before the CRM work: the only statements on the path to an
// INSERT are the two that were always here.
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

// The CRM tracking columns, added separately and only ever *after* a row has
// been inserted. The table already exists on the deployed environment, so
// CREATE TABLE IF NOT EXISTS would skip them — but an ALTER needs privileges
// the Neon role may not have, and a schema change must never be the reason an
// application fails to store. So this is off the insert path and non-fatal:
// if it can't run, the row is already safe and we simply skip the write-back.
async function ensureCrmColumns(sql) {
  if (crmColumnsReady) return true;
  try {
    await sql`
      ALTER TABLE partner_applications
        ADD COLUMN IF NOT EXISTS crm_record_id  TEXT,
        ADD COLUMN IF NOT EXISTS crm_status     TEXT,
        ADD COLUMN IF NOT EXISTS crm_error      TEXT,
        ADD COLUMN IF NOT EXISTS crm_synced_at  TIMESTAMPTZ
    `;
    crmColumnsReady = true;
    return true;
  } catch (err) {
    console.error('CRM_COLUMN_MIGRATION_SKIPPED ' + err.message);
    return false;
  }
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

  /* ------------------------------------------------- 1. Neon comes first */
  let storedId = null;
  const sql = getDb();

  if (!sql) {
    fallback('no POSTGRES_URL or DATABASE_URL configured');
  } else {
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
      storedId = rows[0].id;
      console.log('Partner application stored, id=' + storedId);
    } catch (err) {
      // A database problem must never cost us the lead.
      fallback(err.message);
    }
  }

  /* --------------------------------------------- 2. then mirror to Zoho */
  // Only reached once the Neon outcome is already decided, so nothing here can
  // change whether the application was saved.
  const crm = await zoho.pushLead(data);

  if (crm.ok) {
    console.log('Zoho ' + crm.status + ' in ' + crm.module + ', id=' + crm.id);
  } else if (crm.skipped) {
    console.log('Zoho push skipped — ' + crm.error);
  } else {
    console.error('ZOHO_PUSH_FAILED ' + JSON.stringify({ status: crm.status, error: crm.error, email: data.email }));
    // Neither destination took it — the log line is now the only copy.
    if (storedId === null) fallback('zoho also failed: ' + crm.error);
  }

  // Record the CRM outcome against the row so /api/zoho-sync can retry the
  // failures later. Best-effort: the lead is already safe either way.
  if (storedId !== null && sql && !crm.skipped) {
    try {
      if (!(await ensureCrmColumns(sql))) throw new Error('crm columns unavailable');
      await sql`
        UPDATE partner_applications
           SET crm_record_id = ${crm.id || null},
               crm_status    = ${crm.status || null},
               crm_error     = ${crm.ok ? null : (crm.error || '').slice(0, 1000)},
               crm_synced_at = ${crm.ok ? new Date().toISOString() : null}
         WHERE id = ${storedId}
      `;
    } catch (err) {
      console.error('CRM_STATUS_WRITE_FAILED id=' + storedId + ' ' + err.message);
    }
  }

  return res.status(200).json({
    ok: true,
    stored: storedId !== null,
    id: storedId,
    crm: crm.ok ? { synced: true, id: crm.id } : { synced: false }
  });
};
