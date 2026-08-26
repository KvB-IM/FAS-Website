// Zoho CRM push for partner applications, over Zoho's remote MCP server.
// Shared by /api/apply and /api/zoho-sync.
//
// Neon stays the system of record. Nothing in this file is ever allowed to
// throw into a request handler: every exported function resolves to a plain
// result object, so a CRM outage, an expired URL, or a renamed field can only
// ever cost us the mirror copy — never the lead itself.
//
// WHY MCP AND NOT THE REST API
// Zoho's hosted MCP server authenticates by URL: the token is a path segment,
// and Zoho refreshes the underlying OAuth tokens centrally. So a serverless
// function needs one environment variable and no client secret, no refresh
// token, and no token-expiry handling of its own.
//
// THE URL IS A CREDENTIAL. Anyone holding it can read and write the CRM. It
// belongs in Vercel's environment variables only — never in this repo, never in
// client-side code, never in a log line.
//
// Environment (Vercel → Project → Settings → Environment Variables):
//   ZOHO_MCP_URL     Required to enable the mirror. The full .../message URL
//                    from Zoho MCP. When unset, the CRM step is skipped
//                    entirely and the form behaves exactly as it did before.
//   ZOHO_MODULE      Module API name, default Leads.
//   ZOHO_STAGE       Value for Stage on new records. Empty by default,
//                    because Leads has no Stage field.
//   ZOHO_META_LEADS_TYPE
//                    Value for Meta Leads Type, default
//                    "Fed Advisor Solutions Leads". Set to "" to omit.
//   ZOHO_TYPE        Value for Type, default unset.
//   ZOHO_TIMEOUT_MS  Whole-push budget in ms, default 8000.
//   ZOHO_FIELD_*     Per-field api_name overrides, see FIELD_MAP.
//
// The mirror targets the standard Leads module. The field names below were
// read off the live Leads module through this same MCP server rather than
// guessed, and each is still overridable, because a layout edit in Zoho
// shouldn't need a code change.
//
// Six of the fields the old FB_Leads mapping used do not exist on Leads:
// Licensed_State, Life_Health_License_Status,
// Years_in_insurance_or_financial_services, Experience_with_federal_clients,
// When_are_you_looking_to_launch and Anything_we_should_know_before_the_call.
// State and Description cover two of them; the other four have no equivalent,
// so they are marked api: null and folded into Description as labelled lines.
// Leaving them to the retry loop was not an option — it drops one blamed field
// per attempt and gives up after three.
'use strict';

const DEFAULT_MODULE = 'Leads';
// Leads has no Stage field (that was FB_Leads). Nothing is sent unless
// ZOHO_STAGE is set explicitly.
const DEFAULT_STAGE = '';
// Leads has a text field 'Meta Leads Type' used to tag where a lead came from.
const DEFAULT_META_LEADS_TYPE = 'Fed Advisor Solutions Leads';
const DEFAULT_TIMEOUT_MS = 8000;
const PROTOCOL_VERSION = '2025-06-18';

const FIELD_MAP = {
  firstName: { env: 'ZOHO_FIELD_FIRST_NAME', api: 'First_Name', label: 'First name' },
  lastName: { env: 'ZOHO_FIELD_LAST_NAME', api: 'Last_Name', label: 'Last name' },
  email: { env: 'ZOHO_FIELD_EMAIL', api: 'Email', label: 'Email' },
  phone: { env: 'ZOHO_FIELD_PHONE', api: 'Phone', label: 'Phone' },
  state: { env: 'ZOHO_FIELD_STATE', api: 'State', label: 'Licensed state' },
  licensed: {
    env: 'ZOHO_FIELD_LICENSED',
    api: null,
    label: 'Life & health license status'
  },
  experience: {
    env: 'ZOHO_FIELD_EXPERIENCE',
    api: null,
    label: 'Years in insurance'
  },
  federalExperience: {
    env: 'ZOHO_FIELD_FEDERAL',
    api: null,
    label: 'Experience with federal clients'
  },
  timeline: {
    env: 'ZOHO_FIELD_TIMELINE',
    api: null,
    label: 'Launch timeline'
  },
  notes: {
    env: 'ZOHO_FIELD_NOTES',
    api: 'Description',
    label: 'Notes'
  }
};

// Where overflow goes when a field is rejected — the applicant's own notes
// field, so a rejected value is never simply dropped.
const OVERFLOW_KEY = 'notes';

// Fields we never send even if present in the payload: Zoho owns them.
const NEVER_SEND = ['id', 'Created_Time', 'Modified_Time', 'Created_By', 'Modified_By', 'Owner'];

function env(name) {
  return (process.env[name] || '').trim();
}

// null api means "no field for this on the target module" — the value is
// folded into the notes field instead of being sent on its own.
function fieldName(key) {
  return env(FIELD_MAP[key].env) || FIELD_MAP[key].api || null;
}

function moduleName() {
  return env('ZOHO_MODULE') || DEFAULT_MODULE;
}

function isConfigured() {
  return Boolean(env('ZOHO_MCP_URL'));
}

/* ---------------------------------------------------------- MCP transport */

// Warm invocations reuse the handshake. `initialize` is only required once per
// connection, and re-doing it on every submission would double the latency.
let session = { id: '', ready: false };

function remaining(deadline) {
  return Math.max(0, deadline - Date.now());
}

// One JSON-RPC call. Zoho answers either as plain JSON or as SSE frames
// depending on the endpoint, so both shapes are handled.
async function rpc(method, params, deadline, notification) {
  const budget = remaining(deadline);
  if (budget <= 0) {
    const err = new Error('MCP request budget exhausted');
    err.expired = true;
    throw err;
  }

  const body = Object.assign(
    { jsonrpc: '2.0', method },
    params ? { params } : {},
    notification ? {} : { id: Math.floor(Date.now() % 1e9) + Math.floor(Math.random() * 1000) }
  );

  const headers = {
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream'
  };
  if (session.id) headers['Mcp-Session-Id'] = session.id;

  const controller = new AbortController();
  const timer = setTimeout(function () {
    controller.abort();
  }, budget);

  let res;
  let text;
  try {
    res = await fetch(env('ZOHO_MCP_URL'), {
      method: 'POST',
      headers: headers,
      body: JSON.stringify(body),
      signal: controller.signal
    });
    text = await res.text();
  } catch (err) {
    if (err.name === 'AbortError') {
      const timeout = new Error('MCP request timed out after ' + budget + 'ms');
      timeout.expired = true;
      throw timeout;
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }

  const sid = res.headers.get('mcp-session-id');
  if (sid) session.id = sid;

  if (notification) return null;

  let payload = null;
  const trimmed = (text || '').trim();
  if (trimmed.startsWith('{')) {
    try {
      payload = JSON.parse(trimmed);
    } catch (err) {
      payload = null;
    }
  }
  if (!payload) {
    // SSE framing: take the last data: line that parses as JSON.
    for (const line of (text || '').split('\n')) {
      const t = line.trim();
      if (t.indexOf('data:') === 0) {
        try {
          payload = JSON.parse(t.slice(5).trim());
        } catch (err) {
          /* keep looking */
        }
      }
    }
  }

  if (!payload) {
    throw new Error('MCP returned an unreadable response (HTTP ' + res.status + ')');
  }
  if (payload.error) {
    throw new Error(
      'MCP error ' + (payload.error.code || '') + ': ' + (payload.error.message || 'unknown')
    );
  }
  return payload.result;
}

async function handshake(deadline) {
  if (session.ready) return;
  await rpc(
    'initialize',
    {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: 'fed-advisor-solutions-site', version: '1.0.0' }
    },
    deadline
  );
  await rpc('notifications/initialized', undefined, deadline, true);
  session.ready = true;
}

// Calls a Zoho MCP tool and unwraps the Zoho API JSON out of the MCP envelope.
async function callTool(name, args, deadline) {
  await handshake(deadline);
  const result = await rpc('tools/call', { name: name, arguments: args }, deadline);

  const content = (result && result.content) || [];
  const text = content
    .map(function (part) {
      return part && part.type === 'text' ? part.text : '';
    })
    .join('')
    .trim();

  if (!text) return { isError: Boolean(result && result.isError), body: null, raw: '' };

  let body = null;
  try {
    body = JSON.parse(text);
  } catch (err) {
    body = null;
  }
  return { isError: Boolean(result && result.isError), body: body, raw: text };
}

/* ------------------------------------------------------- record building */

function buildRecord(data, skipKeys) {
  const skip = skipKeys || [];
  const record = {};
  const overflow = [];

  for (const key of Object.keys(FIELD_MAP)) {
    if (key === OVERFLOW_KEY) continue;
    const value = data[key];
    if (!value) continue;
    const name = fieldName(key);
    if (!name || skip.indexOf(name) !== -1) {
      // Either the target module has no field for this, or Zoho rejected it on
      // a previous attempt. Keep the value, just not in that field.
      overflow.push(FIELD_MAP[key].label + ': ' + value);
      continue;
    }
    record[name] = value;
  }

  // Applicant's own message, plus anything Zoho wouldn't take, plus provenance.
  const notesParts = [];
  if (data.notes) notesParts.push(data.notes);
  if (overflow.length) notesParts.push(overflow.join('\n'));
  if (data.page) notesParts.push('Submitted from: ' + data.page);

  const notesField = fieldName(OVERFLOW_KEY);
  if (notesParts.length && skip.indexOf(notesField) === -1) {
    record[notesField] = notesParts.join('\n\n');
  }

  const stage = process.env.ZOHO_STAGE === undefined ? DEFAULT_STAGE : env('ZOHO_STAGE');
  if (stage && skip.indexOf('Stage') === -1) record.Stage = stage;

  // Leads has no Type field; kept for modules that do, and unset by default.
  const type = env('ZOHO_TYPE');
  if (type && skip.indexOf('Type') === -1) record.Type = type;

  // Tags the source of the lead inside the shared Leads module, so these are
  // distinguishable from every other lead flowing into it.
  const metaField = env('ZOHO_FIELD_META_LEADS_TYPE') || 'Meta_Leads_Type';
  const metaValue =
    process.env.ZOHO_META_LEADS_TYPE === undefined
      ? DEFAULT_META_LEADS_TYPE
      : env('ZOHO_META_LEADS_TYPE');
  if (metaValue && skip.indexOf(metaField) === -1) record[metaField] = metaValue;

  for (const banned of NEVER_SEND) delete record[banned];
  for (const key of Object.keys(record)) {
    if (record[key] === null || record[key] === undefined || record[key] === '') delete record[key];
  }

  return record;
}

/* ------------------------------------------------------------- the push */

function firstEntry(body) {
  if (!body) return null;
  if (Array.isArray(body.data)) return body.data[0] || null;
  return body;
}

function describeError(res) {
  const entry = firstEntry(res.body);
  if (entry) {
    const code = entry.code || entry.status;
    const api = entry.details && entry.details.api_name ? ' [' + entry.details.api_name + ']' : '';
    if (code || entry.message) {
      return [code, entry.message].filter(Boolean).join(': ') + api;
    }
  }
  return (res.raw || 'unknown MCP failure').slice(0, 300);
}

// The api_name Zoho blamed, when it blamed one. That's what lets a single bad
// field be dropped and retried rather than failing the whole record.
function blamedField(res) {
  const entry = firstEntry(res.body);
  const api = entry && entry.details && entry.details.api_name;
  if (!api) return null;
  const retryable = ['INVALID_DATA', 'NOT_APPROVED', 'INVALID_URL_PATTERN'];
  const code = entry.code || '';
  return retryable.indexOf(code) !== -1 ? api : null;
}

async function createRecord(record, deadline) {
  return callTool(
    'ZohoCRM_createRecords',
    { path_variables: { module: moduleName() }, body: { data: [record] } },
    deadline
  );
}

async function updateRecord(id, record, deadline) {
  return callTool(
    'ZohoCRM_updateRecord',
    { path_variables: { module: moduleName(), recordId: String(id) }, body: { data: [record] } },
    deadline
  );
}

// The only entry point /api/apply uses. Resolves — never rejects.
async function pushLead(data, options) {
  const opts = options || {};
  if (!isConfigured()) {
    return { ok: false, skipped: true, status: 'not_configured', error: 'ZOHO_MCP_URL is not set.' };
  }

  const budget = Number(opts.timeoutMs) || Number(env('ZOHO_TIMEOUT_MS')) || DEFAULT_TIMEOUT_MS;
  const deadline = Date.now() + budget;
  const skip = [];

  try {
    // Up to three attempts, each dropping one field Zoho explicitly objected
    // to. Without a fields-metadata tool on this MCP server we can't know in
    // advance that, say, a picklist won't accept "Within 30 days" — so we let
    // Zoho tell us, move that value into the notes field, and try again.
    for (let attempt = 0; attempt < 3; attempt++) {
      const record = buildRecord(data, skip);
      if (!Object.keys(record).length) {
        return { ok: false, status: 'error', error: 'Nothing left to send after ' + attempt + ' rejections' };
      }

      const res = await createRecord(record, deadline);
      const entry = firstEntry(res.body);

      if (entry && entry.code === 'SUCCESS' && entry.details && entry.details.id) {
        return {
          ok: true,
          status: 'created',
          id: String(entry.details.id),
          module: moduleName(),
          dropped: skip.slice()
        };
      }

      // A unique field already holds this value: enrich that record instead of
      // failing, so a second application doesn't create a twin.
      if (entry && entry.code === 'DUPLICATE_DATA' && entry.details && entry.details.id) {
        const id = String(entry.details.id);
        const upd = await updateRecord(id, record, deadline);
        const updEntry = firstEntry(upd.body);
        if (updEntry && updEntry.code === 'SUCCESS') {
          return { ok: true, status: 'updated', id: id, module: moduleName(), dropped: skip.slice() };
        }
        return { ok: false, status: 'error', id: id, module: moduleName(), error: 'duplicate update failed — ' + describeError(upd) };
      }

      const blamed = blamedField(res);
      if (blamed && skip.indexOf(blamed) === -1) {
        console.warn('Zoho rejected field ' + blamed + ' — retrying without it');
        skip.push(blamed);
        continue;
      }

      return { ok: false, status: 'error', module: moduleName(), error: describeError(res) };
    }

    return { ok: false, status: 'error', module: moduleName(), error: 'Gave up after 3 field rejections: ' + skip.join(', ') };
  } catch (err) {
    // Force a fresh handshake next time — the session may be the problem.
    session = { id: '', ready: false };
    return {
      ok: false,
      status: err && err.expired ? 'timeout' : 'error',
      error: (err && err.message) || String(err)
    };
  }
}

// Powers /api/zoho-sync?action=fields. There is no fields-metadata tool on this
// MCP server, so each mapped field is verified by asking COQL to select it:
// a wrong api_name comes back as INVALID_QUERY naming the column.
async function describeMapping(options) {
  const opts = options || {};
  if (!isConfigured()) {
    return { configured: false, error: 'ZOHO_MCP_URL is not set.' };
  }

  const deadline = Date.now() + (Number(opts.timeoutMs) || 20000);
  const mapping = {};
  for (const key of Object.keys(FIELD_MAP)) {
    mapping[key] = { api_name: fieldName(key), label: FIELD_MAP[key].label };
  }

  try {
    if (opts.refresh) session = { id: '', ready: false };
    await handshake(deadline);

    const tools = await rpc('tools/list', {}, deadline);
    const names = ((tools && tools.tools) || []).map(function (t) {
      return t.name;
    });

    const needed = ['ZohoCRM_createRecords', 'ZohoCRM_updateRecord', 'ZohoCRM_executeCOQLQuery'];
    const missingTools = needed.filter(function (n) {
      return names.indexOf(n) === -1;
    });

    // One COQL select naming every mapped field at once: if it succeeds, every
    // api_name in the map is real.
    const columns = Object.keys(mapping).map(function (k) {
      return mapping[k].api_name;
    });
    const probe = await callTool(
      'ZohoCRM_executeCOQLQuery',
      {
        body: {
          select_query:
            'select ' + columns.join(', ') + ' from ' + moduleName() + ' where id is not null limit 1'
        }
      },
      deadline
    );

    const body = probe.body || {};
    const fieldsOk = Array.isArray(body.data);

    return {
      configured: true,
      module: moduleName(),
      mcp_tools_present: missingTools.length === 0,
      missing_tools: missingTools,
      fields_verified: fieldsOk,
      field_error: fieldsOk ? null : describeError(probe),
      stage_on_create: process.env.ZOHO_STAGE === undefined ? DEFAULT_STAGE : env('ZOHO_STAGE'),
      mapping: mapping,
      sample_row: fieldsOk ? body.data[0] || null : null
    };
  } catch (err) {
    session = { id: '', ready: false };
    return { configured: true, module: moduleName(), mapping: mapping, error: (err && err.message) || String(err) };
  }
}

function resetCache() {
  session = { id: '', ready: false };
}

module.exports = { pushLead, describeMapping, isConfigured, resetCache, buildRecord, FIELD_MAP };
