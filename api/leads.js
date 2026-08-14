/**
 * GET /api/leads
 *
 * Reads back the partner applications stored by /api/apply so you can pull them
 * without opening a database console.
 *
 * Auth: send the shared secret either as a header or a query string —
 *   curl -H "x-admin-token: YOUR_TOKEN" https://your-site/api/leads
 *   https://your-site/api/leads?token=YOUR_TOKEN&format=csv
 *
 * Environment:
 *   ADMIN_TOKEN   Required. If unset, this endpoint refuses every request.
 *   DATABASE_URL  Same connection string used by /api/apply.
 *
 * Query params:
 *   format=json|csv   (default json)
 *   limit=1..1000     (default 200)
 */

import { neon } from '@neondatabase/serverless';

const CONNECTION_STRING =
  process.env.DATABASE_URL ||
  process.env.POSTGRES_URL ||
  process.env.POSTGRES_URL_NON_POOLING ||
  '';

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
  'source_page'
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

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const expected = process.env.ADMIN_TOKEN || '';
  if (!expected) {
    return res.status(503).json({ error: 'ADMIN_TOKEN is not configured on this deployment.' });
  }

  const url = new URL(req.url, 'http://localhost');
  const supplied = req.headers['x-admin-token'] || url.searchParams.get('token') || '';
  if (supplied !== expected) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  if (!CONNECTION_STRING) {
    return res.status(503).json({ error: 'No database configured on this deployment.' });
  }

  const limit = Math.min(Math.max(parseInt(url.searchParams.get('limit') || '200', 10) || 200, 1), 1000);

  try {
    const sql = neon(CONNECTION_STRING);
    const rows = await sql`
      SELECT id, created_at, first_name, last_name, email, phone, state, licensed,
             experience, federal_experience, timeline, notes, source_page
      FROM partner_applications
      ORDER BY created_at DESC
      LIMIT ${limit}
    `;

    res.setHeader('Cache-Control', 'no-store');

    if (url.searchParams.get('format') === 'csv') {
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', 'attachment; filename="partner-applications.csv"');
      return res.status(200).send(toCsv(rows));
    }

    return res.status(200).json({ count: rows.length, applications: rows });
  } catch (err) {
    console.error('LEADS_READ_ERROR', err);
    return res.status(500).json({ error: 'Could not read applications.' });
  }
}
