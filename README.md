# Fed Advisor Solutions — Partner Agent Program site

Marketing site for the Fed Advisor Solutions Partner Agent Program, built from the
`Federal Benefits Exchange — Partner Agent Program.pptx` deck.

Plain HTML, CSS, and JavaScript — **no build step, no framework**. Open any `.html`
file in a browser and it works. Three Vercel serverless functions handle the
application form: `/api/apply` takes submissions, `/api/leads` reads them back,
and `/api/zoho-sync` inspects and repairs the Zoho CRM mirror.

---

## Pages

| File | Purpose |
|---|---|
| `index.html` | Home — hero, market stats, problem, solution, the five components, how it works |
| `opportunity.html` | The federal market, why it stays under-served, the agent's problem |
| `program.html` | Deep dive on all five components (website, leads, CRM, training, analysis platform) |
| `pricing.html` | Three pricing tiers, the economics chart, FAQ |
| `apply.html` | Fit checklist, three-step process, application form |
| `thank-you.html` | Post-submission confirmation (`noindex`) |

Shared assets: `assets/css/site.css`, `assets/js/site.js`, `assets/img/advisor-hero.jpg`.

The header and footer are duplicated in each page rather than templated — there is no
build step, so **a change to the nav or footer has to be made in all six files.**

---

## Deploying to Vercel

1. Push this repo to GitHub.
2. In Vercel, **Add New → Project** and import `KvB-IM/FAS-Website`.
3. Framework preset: **Other**. Build command: *(leave empty)*. Output directory: *(leave empty / root)*.
4. Deploy.

Vercel installs `@neondatabase/serverless` from `package.json` for the `/api`
functions and serves everything else as static files.

### Where a submission goes

`/api/apply` writes to **two** destinations, in this order:

1. **Neon Postgres — the system of record.** Written first. The response the
   applicant sees depends only on this step.
2. **Zoho CRM, the `FB_Leads` module — a mirror for the sales team.** Attempted
   only after the Neon row is safe, over Zoho's remote MCP server.

A Zoho failure can never affect whether the application was saved, whether the
applicant sees success, or how long they wait beyond the CRM timeout. It is
recorded on the row and retried later — see **The Zoho CRM mirror** below.

### Caching — read this before wondering why a CSS change didn't show up

`vercel.json` used to cache **everything** under `/assets/` for a year with
`immutable`. Since `site.css` and `site.js` never change filename, that meant a
returning visitor's browser would not even check for a new version — every
style or script change was invisible to them, potentially for a year, while
looking fine in a fresh browser or a private window.

That is now split:

| Path | Policy | Why |
|---|---|---|
| `/assets/img/(.*)` | 1 year, `immutable` | Images don't change; rename the file if one does |
| `/assets/(css\|js)/(.*)` | `max-age=300, must-revalidate` | An edit goes live within 5 minutes, no version bump needed |

The `?v=` query string on the `site.css` / `site.js` links in all six pages
exists to break browsers out of the old year-long `immutable` cache. Once
everyone has loaded a page since that change they no longer strictly need it,
but bumping it is still the one reliable way to force a stylesheet refresh for
everybody at once — and it's cheap. **If you change the version, change it in
all six HTML files.**

### The database

The application form posts to `/api/apply`, which writes to a Neon Postgres
database. The database is already provisioned and the `partner_applications`
table already exists.

The handler reads `POSTGRES_URL || DATABASE_URL` — Vercel's Neon integration sets
both when the database is attached to the project, so no manual configuration is
needed as long as the storage integration is connected. `/api/apply` also
re-creates the table if it is ever missing and adds the `crm_*` columns if they
aren't there yet, so there is no migration step.

**Never commit a connection string.** It belongs only in Vercel's environment
variables. `.env` and `.env*.local` are gitignored.

**Nothing is lost if the database is missing or down.** `/api/apply` falls back to
writing the full submission to the function log as a single line beginning
`APPLICATION_FALLBACK`, and still returns success to the applicant. Check
**Project → Logs** and search for that string. The CRM push is still attempted in
that case, so a Neon outage on its own usually costs nothing — the log line is
only the last copy when Zoho fails too, which is why it's written either way.

### Reading applications back

Set an `ADMIN_TOKEN` environment variable in Vercel to any long random string, then:

```bash
curl -H "x-admin-token: YOUR_TOKEN" https://fedadvisorsolutions.com/api/leads
```

Add `?format=csv` for a spreadsheet-ready download, and `?limit=500` to pull more
than the default 200. Without `ADMIN_TOKEN` set, the endpoint refuses every request.

Each row also carries `crm_record_id`, `crm_status`, and `crm_synced_at`, so the
CRM mirror can be audited from the same export.

---

## The Zoho CRM mirror

Every application is also created in the **`FB_Leads`** module, filling the
`FB Advisor Leads` section. The push goes through **Zoho's remote MCP server**,
not the REST API — which means the deployment holds **no client secret and no
refresh token**. Zoho's MCP server authenticates by URL and refreshes the
underlying OAuth tokens centrally, so the site needs exactly one environment
variable.

> **`ZOHO_MCP_URL` is a credential.** The access token is a path segment inside
> it, so anyone holding the URL can read and write your CRM. It belongs in
> Vercel's environment variables only — never committed, never in client-side
> code, never pasted into a shared channel. Rotate it in Zoho MCP if it leaks.

### Setting it up

1. In Zoho MCP, open the **CRM Data & Metadata** server and copy its URL — the
   full one ending in `/message`.
2. In Vercel, add it as `ZOHO_MCP_URL`. That's the whole setup.

With `ZOHO_MCP_URL` unset the CRM step is skipped silently and the form behaves
exactly as it did before, so deploying this without the variable changes nothing.

### The field mapping

These api_names were read off the live `FB_Leads` module through the MCP server,
not guessed. Each is overridable with the matching environment variable so a
layout edit in Zoho never needs a code change.

| Form field | Zoho api_name | Override |
|---|---|---|
| First name | `First_Name` | `ZOHO_FIELD_FIRST_NAME` |
| Last name | `Last_Name` | `ZOHO_FIELD_LAST_NAME` |
| Email | `Email` | `ZOHO_FIELD_EMAIL` |
| Phone | `Phone` | `ZOHO_FIELD_PHONE` |
| State licensed in | `Licensed_State` | `ZOHO_FIELD_STATE` |
| Life & health license status | `Life_Health_License_Status` | `ZOHO_FIELD_LICENSED` |
| Years in insurance | `Years_in_insurance_or_financial_services` | `ZOHO_FIELD_EXPERIENCE` |
| Experience with federal clients | `Experience_with_federal_clients` | `ZOHO_FIELD_FEDERAL` |
| Launch timeline | `When_are_you_looking_to_launch` | `ZOHO_FIELD_TIMELINE` |
| Notes | `Anything_we_should_know_before_the_call` | `ZOHO_FIELD_NOTES` |

New records also get `Stage` = `New Lead` (change with `ZOHO_STAGE`, or set it to
an empty string to leave `Stage` to the module's own default).

`Name` is deliberately **not** sent — Zoho populates it itself.

### Verify the mapping any time

```bash
curl -H "x-admin-token: YOUR_TOKEN" \
  "https://fedadvisorsolutions.com/api/zoho-sync?action=fields"
```

This MCP server exposes no fields-metadata tool, so verification works by asking
COQL to select every mapped field at once: `"fields_verified": true` means every
api_name above really exists in the module. It also confirms the MCP tools the
push depends on are present, and returns a sample row. Add `&refresh=1` to
force a new MCP handshake.

### Backfilling and retries

A failed push is never a lost lead — the row stays in Neon with
`crm_record_id` still null.

```bash
curl -H "x-admin-token: YOUR_TOKEN" "https://.../api/zoho-sync?action=pending"
curl -H "x-admin-token: YOUR_TOKEN" "https://.../api/zoho-sync?action=retry&limit=25"
```

`retry` works oldest-first, writes the outcome back to each row, and stops after
the first row if it fails — a first-row failure is almost always the URL or the
mapping, not that one record. This is also how you backfill applications taken
before the mirror existed.

### Behaviour worth knowing

- **A second application from the same email updates the existing record**
  rather than creating a duplicate, whenever Zoho reports the email as a
  duplicate.
- **A field Zoho rejects is dropped and the record retried, up to three times.**
  This MCP server can't tell us in advance whether, say,
  `When_are_you_looking_to_launch` is a picklist that won't accept
  "Within 30 days" — so Zoho is allowed to say no, that one value moves into the
  notes field, and the record still lands. A picklist that drifts out of sync
  with the form degrades instead of failing.
- **Neon is never at risk.** See below.

### How the two destinations are kept independent

This matters more than the CRM integration itself, so it is worth being explicit:

- The **only** statements that run before the `INSERT` are the `CREATE TABLE IF
  NOT EXISTS` and `CREATE INDEX IF NOT EXISTS` that were always there. The
  `ALTER TABLE` that adds the `crm_*` columns runs **after** the row is stored
  and is wrapped so a role without `ALTER` privileges just logs
  `CRM_COLUMN_MIGRATION_SKIPPED` and carries on.
- The CRM push happens **after** the Neon outcome is already decided, and cannot
  change the response the applicant sees.
- Writing the CRM status back to the row is best-effort; if it fails the lead is
  already safe.
- If Neon fails and the CRM push succeeds, the lead is still in CRM. Only if
  **both** fail does the `APPLICATION_FALLBACK` log line become the copy of
  record — which is why it is still written either way.

### Environment variables

| Name | Required | Purpose |
|---|---|---|
| `POSTGRES_URL` or `DATABASE_URL` | Set automatically by the Vercel Neon integration | Where applications are stored |
| `ADMIN_TOKEN` | To use `/api/leads` or `/api/zoho-sync` | Shared secret for reading applications back |
| `ZOHO_MCP_URL` | For the CRM mirror | Zoho MCP server URL. **Treat as a password.** Unset = mirror disabled |
| `ZOHO_MODULE` | No | Module api_name, default `FB_Leads` |
| `ZOHO_STAGE` | No | `Stage` on new records, default `New Lead`. Empty string = leave unset |
| `ZOHO_TYPE` | No | `Type` on new records, default unset |
| `ZOHO_TIMEOUT_MS` | No | Whole-push budget, default `8000` |
| `ZOHO_FIELD_*` | No | Per-field api_name overrides, see the table above |

---


## Before you go live

These are the placeholders and open items in the current build:

- **Phone number** — no phone number appears anywhere. The deck said "Call Mario
  Roker" but gave no number. Add one to the footer `Contact` block in all six pages
  when you have the number you want published.
- **Email** — `partners@fedadvisorsolutions.com` is used throughout. Make sure that
  mailbox exists, or search and replace it.
- **Booking link** — every CTA points at `apply.html`. If you'd rather send people
  straight to a scheduler, replace the `href="apply.html"` on the primary buttons
  with your Calendly/Chili Piper URL.
- **Hero photo** — `assets/img/advisor-hero.jpg` came from the deck. Confirm you hold
  a license for it, or swap in your own photo at the same 4:5 aspect ratio.
- **Market statistics** — the 2.2M / 600K / 2.6M / $500K figures and their OPM, USPS,
  and TSP sourcing carried over from the deck. Refresh them against current OPM
  FedScope and TSP reports before publishing.
- **Compliance review** — the non-affiliation disclosure and income disclaimer in the
  footer were written to match the deck's stated requirement. Have whoever handles
  your advertising compliance read them before launch.

## Lead numbers

The deck said two different things: the package and pricing slides say **50 leads at
launch** with reorders at $50/lead, while the CRM slide and the economics chart
assumed **100 leads per month**.

The site now uses one figure throughout: **50 leads delivered with the launch
package, reordered at $50/lead pass-through, 50-lead minimum.** The 100/month
assumption is gone.

The economics scenarios on `pricing.html` are driven by **rollovers closed per month**
(2 / 3 / 4), not by a lead volume — so the $216K / $324K / $432K figures stand on
their own and don't depend on any particular pipeline size. If you later settle on a
recurring monthly lead count, the places to update are:

- `pricing.html` — the "Lead Supply" tile in the economics section and the footnote below the chart
- `pricing.html` — the "Additional Leads" price card
- `program.html` — the "50 Fresh Federal Leads" section
- `index.html` — the hero, the trust strip, the solution and component cards, and the meta description
- `apply.html` — step 03 and the meta description

---

## Local preview

Any static server works:

```bash
npx serve .
```

The `/api` routes only run on Vercel. To exercise them locally, use `npx vercel dev`.
