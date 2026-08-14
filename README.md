# Fed Advisor Solutions — Partner Agent Program site

Marketing site for the Fed Advisor Solutions Partner Agent Program, built from the
`Federal Benefits Exchange — Partner Agent Program.pptx` deck.

Plain HTML, CSS, and JavaScript — **no build step, no framework**. Open any `.html`
file in a browser and it works. Two Vercel serverless functions handle the
application form.

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

### Connecting the database

The application form posts to `/api/apply`, which writes to Postgres.

1. Vercel dashboard → your project → **Storage** → **Create Database** → **Neon (Postgres)**.
2. Connect it to the project. Vercel sets `DATABASE_URL` automatically.
3. Redeploy.

The `partner_applications` table is created automatically on the first submission —
no migration to run.

**Nothing is lost if the database is missing or down.** `/api/apply` falls back to
writing the full submission to the function log as a single line beginning
`APPLICATION_FALLBACK`, and still returns success to the applicant. Check
**Project → Logs** and search for that string.

### Reading applications back

Set an `ADMIN_TOKEN` environment variable in Vercel to any long random string, then:

```bash
curl -H "x-admin-token: YOUR_TOKEN" https://fedadvisorsolutions.com/api/leads
```

Add `?format=csv` for a spreadsheet-ready download, and `?limit=500` to pull more
than the default 200. Without `ADMIN_TOKEN` set, the endpoint refuses every request.

### Environment variables

| Name | Required | Purpose |
|---|---|---|
| `DATABASE_URL` | Set automatically by the Vercel Postgres/Neon integration | Where applications are stored |
| `ADMIN_TOKEN` | Only to use `/api/leads` | Shared secret for reading applications back |

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

## Lead-count inconsistency carried over from the deck

The deck said two different things: the package slides and pricing slide say **50
leads at launch** with reorders at $50/lead, while the CRM slide and the economics
chart assume **100 leads per month**.

This site treats **50-at-launch plus reorders** as the offer, and the economics
section on `pricing.html` states its assumption explicitly ("a working pipeline of
100 leads per month — 50 delivered with your launch package, with additional leads
ordered at $50 each"). If the real offer is a recurring 100/month, update
`pricing.html` and the lead copy on `program.html` and `index.html` to match.

---

## Local preview

Any static server works:

```bash
npx serve .
```

The `/api` routes only run on Vercel. To exercise them locally, use `npx vercel dev`.
