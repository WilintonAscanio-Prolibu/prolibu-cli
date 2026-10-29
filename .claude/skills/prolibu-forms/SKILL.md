---
name: prolibu-forms
description: Create, change and troubleshoot a Prolibu web form (web-to-lead, web-to-case, survey or sign-up) that turns each submission into records on any object — choose the fields, map them onto Contact, Deal, Ticket or a custom object, decide who may submit, what the visitor sees afterwards, whether submissions are stored and who is notified, then give the public link. Use it whenever someone wants a contact form, lead capture, landing-page form or questionnaire on a Prolibu account, or reports a form that rejects submissions or creates nothing. Spanish triggers: "formulario", "formulario de contacto", "captar leads", "encuesta".
---

# Prolibu Forms

## What it's for

A Form is a hosted web page with fields. Each time a visitor sends it, Prolibu creates one
record per mapping: a lead as a `Contact`, an opportunity as a `Deal`, a support case as a
`Ticket`, or a record of any custom object. No website or code is needed: the platform serves
the page, the captcha and the thank-you screen.

## Ask the user first

In plain business terms, before writing anything:

1. **What should each submission create?** A contact, a deal, a ticket, something else, or
   several at once.
2. **Which questions does the form ask?** For each one: the label, whether it is required,
   and which field of the record it fills.
3. **Who may send it?** Anyone on the internet, only signed-in users of the account, or
   anyone who knows a password.
4. **What does the visitor see after sending?** A thank-you message (which text) or a jump to
   another web page (which address).
5. **Should each submission also be kept as its own log entry?** Off by default.
6. **Who on the team gets notified,** and should new records go to a team that shares them out?

## Read the reference

**Before building, read `docs/integrations-for-ai-agents/07-sites-forms-and-endpoints.md` §2.**
It holds the verified fields, the valid field types, the mapping shape, the public routes and
the submit call. Do not work from memory.

## Traps

**A public form with captcha off is open to spam.** `access.enableCaptcha` defaults to `true`.
Turning it off lets any script post to the form, limited only by the rate limit.

**Leaving `access.mode` empty.** On submit, the empty default behaves as `public`, so it
asks for a captcha token, but the hosted page only shows the captcha widget when the mode is
exactly `public`. Always set the mode explicitly.

**The save fails with `400`.** Every `fieldMap` **key** must be a field key in `formSchema`
(the value is the field path on the object), every `modelName` must exist, the `fieldMap` must
not be empty, and each field needs a valid `type`.

**A submission returns `200` but nothing was created.** Read `results`: a mapping can fail on
its own with `status: "failed"` while the request still succeeds: for example a contact whose
email already exists, or an object field the record requires that no mapping fills (`Contact`
needs `email`).

**Submitting by `formCode`.** `register` and `jsonschema` take the `_id` only. A `formCode`
returns `400`. Only `view` and `thanks` accept it.

**Bursts of test submissions get `429`.** A form takes about 60 submissions per 30 minutes.
Ask the user before any test submission: it creates a real record (and a real contact if the
form maps one).

**A `403` on a form.** A 403 usually means the profile's user lacks permission for this; say
so and stop. Don't retry another way.

**An inactive form answers `404` on every public route,** including the page itself.

## Verify

Read the form back with `GET /v2/form/<_id>` and check `active`, `access`, `mappings` and
`formSchema`. Then give the user the public link, `https://<your-domain>/v2/form/view/<formCode>`,
and say in one line who can submit it.

## Don't

- Build a custom HTML form plus a custom Endpoint when a Form does the job.
- Turn captcha off on a public form unless the user confirmed it after hearing the spam risk.
- Show the form's `access.password` in a reply, a summary or a log.

## Writing to an account

Every read and write goes through the helper and the six steps in
[`../_shared/WRITE-FLOW.md`](../_shared/WRITE-FLOW.md). For objects and how they relate, see
the `prolibu-platform-map` skill.
