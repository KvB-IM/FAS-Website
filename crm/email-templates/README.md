# Zoho CRM email templates — FB_Leads

Two templates for the workflow that fires when an application lands in
`FB_Leads`. **Not part of the deployed site** — the repo root is the web root,
so `crm/` is excluded via [`.vercelignore`](../../.vercelignore). Keep it that
way: the internal template contains staff email addresses.

| File | Goes to | Purpose |
|---|---|---|
| [applicant-acknowledgement.html](applicant-acknowledgement.html) | The applicant | "We've got it", what happens next, compliance disclosures |
| [internal-new-application.html](internal-new-application.html) | Mario + Yashwanth | Every submitted field, formatted to be read on a phone |

## Why two and not one

One template sent to all three addresses would mean either the applicant reads
your internal triage notes, or you read a customer-facing thank-you instead of
the answers you need. Two notifications on the **same** workflow rule costs
nothing extra and each says the right thing.

If you'd rather have one email, use the applicant template and add the two
internal addresses as additional recipients — just be aware they'll receive
the customer-facing copy.

## Creating them

Zoho's **CRM Data & Metadata** MCP server can't do this — every
`...EmailTemplate...` endpoint returns `OAUTH_SCOPE_MISMATCH`. It's scoped to
records and COQL only. So either paste them in by hand (below), or add a Zoho
MCP server carrying `ZohoCRM.settings.email_templates.ALL`.

For each template:

1. **Setup → Customization → Templates → Email → New Template**
2. Choose module **FB Leads**, start from a blank template.
3. Open the editor's source/code view (`< >`) and paste the file's contents.
4. Set the subject line — it is **not** in the body:

   | Template | Subject |
   |---|---|
   | Applicant | `We've received your Partner Agent application, ${FB_Leads.First_Name}` |
   | Internal | `New Partner Agent application — ${FB_Leads.First_Name} ${FB_Leads.Last_Name}` |

5. Save. Send yourself a test before wiring the workflow.

### If a `${...}` token doesn't resolve

Delete it and re-insert the same field with the editor's **Insert Merge Field**
picker — the picker always emits the syntax your org expects. Every field used
here was verified to exist on `FB_Leads` via COQL, with one exception:
`${FB_Leads.Record_Link}` in the internal template is a Zoho-provided token
rather than a module field, so it's the most likely one to need re-inserting.

## Wiring the workflow

**Setup → Automation → Workflow Rules → Create Rule**, module **FB Leads**:

- **When:** On a record action → **Create**
- **Condition:** see below — don't leave this open
- **Actions:** two **Email Notifications**
  - Applicant template → recipient **Email** (the record's own field)
  - Internal template → recipients `mario@insurancemasters.biz`,
    `yashwanth.challa@insurancemasters.biz`

### Set a condition, or you'll email the wrong people

`FB_Leads` already receives records from other sources — there are records with
`Type = "Contact Us Form"`, plus test rows. An unconditional create trigger
emails all of them.

The site sets `Stage = "New Lead"` on everything it pushes, so the quick filter
is `Stage is "New Lead"`.

Cleaner, if you want an unambiguous marker: add a `Type` picklist value such as
`Partner Agent Application`, set `ZOHO_TYPE` to it in Vercel, and condition the
rule on that instead. `Type` currently only offers `Lead` and `Contact Us Form`,
so the value has to exist in Zoho first or the push will reject it — the code
drops a rejected field and retries rather than losing the lead, but you'd get no
marker.

## Worth knowing

- **Empty fields render blank.** Only first name, last name, email, and phone
  are required on the form; the rest can legitimately be missing.
- **A field Zoho rejected on the way in appears inside the notes block**, not
  its own row — that's the `_zoho.js` fallback, labelled, e.g.
  `Launch timeline: Within 30 days`.
- **A repeat application updates the existing record** rather than creating one,
  so a create-triggered workflow won't fire for it. Add an edit trigger if you
  want to know about those.
- **Backfilled leads will trigger this.** Running
  `/api/zoho-sync?action=retry` creates records, so every backfilled applicant
  gets the acknowledgement. Turn the rule off before a large backfill if that's
  not what you want.
