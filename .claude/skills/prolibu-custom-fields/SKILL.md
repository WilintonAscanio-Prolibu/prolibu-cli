---
name: prolibu-custom-fields
description: Add, change and troubleshoot custom fields on a Prolibu object (Contact, Deal, Company, Ticket, Product or a custom object) and, when nothing existing fits, plan a brand-new custom object — choose the field type, options and requirements, warn that every schema change restarts the account (about 15 s on dev accounts), write the change, then confirm it loaded. Use it whenever someone wants an extra field, a new attribute, a dropdown or a lookup on a record, a new kind of record or object, or reports a custom field that does not save, does not show up or was switched off. Spanish triggers: "campo personalizado", "agregar un campo", "objeto personalizado", "lista desplegable".
---

# Prolibu Custom Fields

## What it's for

A Custom Field record adds fields to an object that already exists: under `customFields.<name>`
on the record, or at the record's root through `overrides` (which can also tighten a built-in
field, such as making it required). A Custom Object (Cob) creates a whole new object with its
own records and API. Both are schema changes: the platform restarts the account to load them.

## Ask the user first

In plain business terms, before writing anything:

1. **A field on something that exists, or a new kind of record?** Prefer a field on an
   existing object; a new object only when its records have their own life and list.
2. **For each field:** its name, its type (text, number, yes/no, date, a fixed list of
   options, a link to another record, several values), whether it is required, and its options.
3. **Who must see it?** By default everyone who can read the object sees it. Hiding it from
   some roles is a separate field-level permission on the role; this skill does not change roles.
4. **When may the account restart?** Every schema change restarts it: about 15 s observed on dev
   accounts, possibly longer on production.

## Read the reference

**Before building, read `docs/integrations-for-ai-agents/02-custom-objects-and-fields.md`.** It
holds the valid types, the payload shapes, `customFields` vs `overrides` and the Cob naming
rules. Do not work from memory.

## Traps

**Every create, update or delete of a Custom Field or a Cob restarts the account's servers.**
Warn the user that the account restarts (about 15 s observed on dev accounts; may be longer on
production; poll until the API answers again, don't sleep a fixed time) and that requests made
meanwhile, theirs or their team's, can fail. Say it in the summary and get an explicit yes for
the schema change. Group all field changes into one write.

**There is one Custom Field record per object, active or not.** Read
`GET /v2/customfield?objectAssigned=<Object>` first. If one exists, update it; a second create
fails with `400`.

**An update replaces the whole `customFields` (or `overrides`) block.** Send the existing
fields plus the new ones. A field left out disappears from the schema.

**Each entry needs `"isCustomField": true` and a `type`.** Names are identifiers (letters,
digits, `_`, `$`, no leading digit). `index: true` is allowed only on text fields.

**Writes before the restart lose the new fields silently.** Undeclared fields are dropped
with no error. Wait until the account answers again before writing values.

**A field that failed to load switches the whole record off.** After the restart, read the
record's `status` and `active`. `Success: …` means loaded. `Error: …` or `Index sync error: …`
means the platform set `active: false` and none of that object's custom fields apply (for
example, a `unique` field whose existing records already repeat a value). Show the status to
the user; fix the cause before reactivating, which is another restart.

**`objectAssigned` is the object's model name** (`Contact`, `Deal`). A new Cob accepts custom
fields only after its own restart finished.

**A `403` on a Custom Field or Cob.** A 403 usually means the profile's user lacks permission
for this; say so and stop. Don't retry another way.

## Verify

After the restart, read `GET /v2/customfield/<_id>` and check `status` and `active`. Then
write the field on one test record the user picks, read it back (`customFields.<name>` for
nested fields, the root for `overrides`) and give the user the record's `_id`.

## Don't

- Create a Cob when a custom field on an existing object does the job.
- Rename, retype or delete a field, or delete a Custom Field record or a Cob, without a
  separate confirmation: existing data depends on them, and each is another restart.
- Retry a schema change in a loop while the account restarts; read back first.

## Writing to an account

Prefer the helper and the six steps in [`../_shared/WRITE-FLOW.md`](../_shared/WRITE-FLOW.md).
If `accounts/<domain>/objects/CustomField/` or `.../Cob/` holds files, the user versions
objects with the CLI: after a helper write, run `./prolibu customfield pull --domain <domain>`
so the files match. Run `./prolibu customfield push` or `cob push` only after the user said
yes to that exact command, and warn first: it sends every file in the folder and restarts the
account once per file, unchanged files included. For objects and how they relate, see the
`prolibu-platform-map` skill.
