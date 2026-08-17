// GET /api/leads — read back the applications stored by /api/apply.
//
//   curl -H "x-admin-token: YOUR_TOKEN" https://your-site/api/leads
//   https://your-site/api/leads?token=YOUR_TOKEN&format=csv
//
// Environment:
//   ADMIN_TOKEN                   Required. Without it every request is refused.
//   POSTGRES_URL / DATABASE_URL   Same connection string used by /api/apply.
//
// Query params: format=json|csv (default json), limit=1..1000 (default 200).
const { neon } = require('@neondatabase/serverless');

const COLUMNS = [
  'id',
  'created_at',
  'first_name',
  'last_name',
  'email',
  'phone',
  'state',
  'licensed',
  'experience',
  'federal_experience',
  'timeline',
  'notes',
  'source_page',
  'crm_record_id',
  'crm_status',
  'crm_synced_at'
];

function toCsv(rows) {
  const escape = (value) => {
    if (value === null || value === undefined) return '';
    const text = value instanceof Date ? value.toISOString() : String(value);
    return /[",\n\r]/.test(text) ? '"' + text.replace(/"/g, '""') + '"' : text;
  };
  const lines = [COLUMNS.join(',')];
  for (const row of rows) {
    lines.push(COLUMNS.map((c) => escape(row[c])).join(','));
  }
  return lines.join('\n');
}

// Constant-time-ish compare so the token can't be guessed byte by byte.
function tokensMatch(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

module.exports = async function handler(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const expected = process.env.ADMIN_TOKEN || '';
  if (!expected) {
    return res.status(503).json({ error: 'ADMIN_TOKEN is not configured on this deployment.' });
  }

  const url = new URL(req.url, 'http://localhost');
  const header = req.headers['x-admin-token'];
  const supplied = (Array.isArray(header) ? header[0] : header) || url.searchParams.get('token') || '';
  if (!tokensMatch(supplied, expected)) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const connectionString = process.env.POSTGRES_URL || process.env.DATABASE_URL;
  if (!connectionString) {
    return res.status(503).json({ error: 'No database configured on this deployment.' });
  }

  const requested = parseInt(url.searchParams.get('limit') || '200', 10);
  const limit = Math.min(Math.max(isNaN(requested) ? 200 : requested, 1), 1000);

  try {
    const sql = neon(connectionString);

    // The crm_* columns are added by /api/apply's migration. On a deployment
    // where no application has been submitted since the CRM mirror shipped
    // they won't exist yet, so fall back to the original column set rather
    // than failing the read.
    let rows;
    try {
      rows = await sql`
        SELECT id, created_at, first_name, last_name, email, phone, state, licensed,
               experience, federal_experience, timeline, notes, source_page,
               crm_record_id, crm_status, crm_synced_at
        FROM partner_applications
        ORDER BY created_at DESC
        LIMIT ${limit}
      `;
    } catch (err) {
      const missingColumn = err.code === '42703' || /column .* does not exist/i.test(err.message || '');
      if (!missingColumn) throw err;
      rows = await sql`
        SELECT id, created_at, first_name, last_name, email, phone, state, licensed,
               experience, federal_experience, timeline, notes, source_page
        FROM partner_applications
        ORDER BY created_at DESC
        LIMIT ${limit}
      `;
    }

    res.setHeader('Cache-Control', 'no-store');

    if (url.searchParams.get('format') === 'csv') {
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', 'attachment; filename="partner-applications.csv"');
      return res.status(200).send(toCsv(rows));
    }

    return res.status(200).json({ count: rows.length, applications: rows });
  } catch (err) {
    console.error('LEADS_READ_ERROR', err.message);
    return res.status(500).json({ error: 'Could not read applications.' });
  }
};
