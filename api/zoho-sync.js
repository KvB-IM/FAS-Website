// GET /api/zoho-sync — inspect and repair the Zoho CRM mirror.
//
// Neon holds every application; this endpoint is how the ones that didn't make
// it into CRM get there, and how the field mapping is checked before anyone
// relies on it.
//
//   # which Zoho field did each form field resolve to?
//   curl -H "x-admin-token: TOKEN" https://your-site/api/zoho-sync?action=fields
//
//   # what is still missing from CRM?
//   curl -H "x-admin-token: TOKEN" https://your-site/api/zoho-sync?action=pending
//
//   # push those rows now (default action)
//   curl -H "x-admin-token: TOKEN" https://your-site/api/zoho-sync?action=retry&limit=25
//
// Environment:
//   ADMIN_TOKEN                   Required. Without it every request is refused.
//   POSTGRES_URL / DATABASE_URL   Same connection string used by /api/apply.
//   ZOHO_MCP_URL                  Zoho MCP server URL. See api/_zoho.js.
//
// Query params:
//   action=retry|pending|fields   default retry
//   limit=1..200                  default 25 (retry), 200 (pending)
//   refresh=1                     with action=fields, re-reads Zoho metadata
//                                 instead of using the cached mapping
const { neon } = require('@neondatabase/serverless');
const zoho = require('./_zoho');

// Constant-time-ish compare so the token can't be guessed byte by byte.
function tokensMatch(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function toPayload(row) {
  return {
    firstName: row.first_name || '',
    lastName: row.last_name || '',
    email: row.email || '',
    phone: row.phone || '',
    state: row.state || '',
    licensed: row.licensed || '',
    experience: row.experience || '',
    federalExperience: row.federal_experience || '',
    timeline: row.timeline || '',
    notes: row.notes || '',
    page: row.source_page || ''
  };
}

module.exports = async function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'POST') {
    res.setHeader('Allow', 'GET, POST');
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

  res.setHeader('Cache-Control', 'no-store');
  const action = url.searchParams.get('action') || 'retry';

  /* ------------------------------------------------------ field mapping */
  if (action === 'fields') {
    const mapping = await zoho.describeMapping({ refresh: url.searchParams.get('refresh') === '1' });
    return res.status(mapping.error ? 502 : 200).json(mapping);
  }

  const connectionString = process.env.POSTGRES_URL || process.env.DATABASE_URL;
  if (!connectionString) {
    return res.status(503).json({ error: 'No database configured on this deployment.' });
  }

  const requested = parseInt(url.searchParams.get('limit') || '', 10);
  const sql = neon(connectionString);

  /* ----------------------------------------------------------- pending */
  if (action === 'pending') {
    const limit = Math.min(Math.max(isNaN(requested) ? 200 : requested, 1), 500);
    try {
      const rows = await sql`
        SELECT id, created_at, first_name, last_name, email, crm_status, crm_error
        FROM partner_applications
        WHERE crm_record_id IS NULL
        ORDER BY created_at DESC
        LIMIT ${limit}
      `;
      return res.status(200).json({ count: rows.length, pending: rows });
    } catch (err) {
      console.error('ZOHO_SYNC_PENDING_ERROR', err.message);
      return res.status(500).json({ error: 'Could not read applications.' });
    }
  }

  if (action !== 'retry') {
    return res.status(400).json({ error: 'Unknown action. Use retry, pending, or fields.' });
  }

  /* ------------------------------------------------------------- retry */
  if (!zoho.isConfigured()) {
    return res.status(503).json({ error: 'ZOHO_MCP_URL is not configured on this deployment.' });
  }

  // Deliberately small default: each row is a live API round trip and the
  // function has a wall-clock limit. Call it again to work through a backlog.
  const limit = Math.min(Math.max(isNaN(requested) ? 25 : requested, 1), 200);

  let rows;
  try {
    rows = await sql`
      SELECT id, first_name, last_name, email, phone, state, licensed, experience,
             federal_experience, timeline, notes, source_page
      FROM partner_applications
      WHERE crm_record_id IS NULL
      ORDER BY created_at ASC
      LIMIT ${limit}
    `;
  } catch (err) {
    console.error('ZOHO_SYNC_READ_ERROR', err.message);
    return res.status(500).json({ error: 'Could not read applications.' });
  }

  const results = [];
  let synced = 0;

  for (const row of rows) {
    const crm = await zoho.pushLead(toPayload(row));
    if (crm.ok) synced++;

    try {
      await sql`
        UPDATE partner_applications
           SET crm_record_id = ${crm.id || null},
               crm_status    = ${crm.status || null},
               crm_error     = ${crm.ok ? null : (crm.error || '').slice(0, 1000)},
               crm_synced_at = ${crm.ok ? new Date().toISOString() : null}
         WHERE id = ${row.id}
      `;
    } catch (err) {
      console.error('ZOHO_SYNC_WRITE_ERROR id=' + row.id + ' ' + err.message);
    }

    results.push({
      id: row.id,
      email: row.email,
      ok: crm.ok === true,
      status: crm.status || null,
      crm_id: crm.id || null,
      error: crm.ok ? null : crm.error || null
    });

    // A hard failure on the first row is almost always a credential or mapping
    // problem, not a per-record one. Stop rather than burn the whole batch.
    if (!crm.ok && results.length === 1 && rows.length > 1) {
      return res.status(200).json({
        attempted: 1,
        synced: 0,
        remaining: rows.length - 1,
        stopped: 'First record failed — check /api/zoho-sync?action=fields before retrying the rest.',
        results: results
      });
    }
  }

  return res.status(200).json({ attempted: results.length, synced: synced, results: results });
};
