---
name: prolibu-external-refs
description: Link Prolibu records to the same records in another system (ERP, CRM, billing, marketing tool, help desk) with the built-in refId and refUrl fields every object has — store the other system's id and a link back, find a record again by that id, import or sync without creating duplicates, and unlink. Use it whenever someone mentions refId or refUrl, an external id, a correlation or matching key, "the id from our ERP", avoiding duplicates on import or sync, or a link from a Prolibu record to the original record elsewhere. Spanish triggers: "id de HubSpot/ERP", "id externo", "no duplicar", "enlazar con otro sistema".
---

# Prolibu External References

## What it's for

Every record in Prolibu, on every object, has two built-in fields for "this record also lives
somewhere else": `refId` holds the record's id in the other system and `refUrl` holds a link
that opens it there. With them an import or sync finds the record it created last time and
updates it instead of creating a second one, and anyone can jump from Prolibu to the original.
The Prolibu app does not show them; they are read, written and searched through the API.

## Ask the user first

In plain business terms, before writing anything:

1. **Which other system,** and which Prolibu records mirror its records (contacts, deals…).
2. **What does an id there look like?** One example, so you know it is text like `CUS-10482`.
3. **Is there a web address that opens a record there?** Its pattern with the id in it, for
   `refUrl`. If there is none, leave `refUrl` empty.
4. **Does any other system already link these same records?** One record holds one `refId`.

## Read the reference

**Before building, read `docs/integrations-for-ai-agents/13-external-references.md`.** It holds
the verified behavior, the uniqueness rule and the upsert flow. Do not work from memory.

## Traps

**Ids must be sent as text.** `refId` keeps the type it receives: a number is stored as a
number, `?refId=` cannot find it, and the duplicate check skips it. Always send `String(id)`.

**Search before you create.** Contact, Company, Deal and Product reject a second record with
the same text `refId` (account-wide); every other object you write accepts duplicates
silently. Run
`GET /v2/<object>?refId=<value>&limit=2` first: one match → update it, none → create it,
two → stop and show the user the duplicates. An account that already had duplicates when the
rule arrived may have it off on that object, so search first even on those four.

**A `400` on create can mean "already exists".** On those four objects, read the record by
`refId` and offer to update it instead.

**A built-in CRM sync owns `refId`.** Read `GET /v2/syncconnection`. If an active connection
lists the object in `objects[].objectType` (entry `active`, `direction` not `off`), do not write
`refId` there: the sync would use it to update the wrong external record. Suggest a custom
field instead (the `prolibu-custom-fields` skill, if available). If that read returns `403` or
fails, stop and ask the user; never assume there is no sync.

**`refId` sent to `/v2/contact/submit` goes to the submission entry, not the contact.** Use a
normal create or update on the contact to link it.

**Put `refId` in the create body,** not in a follow-up update, so no record exists without it.

**A `403` on the object.** A 403 usually means the profile's user lacks permission for this;
say so and stop. Don't retry another way.

## Verify

Read the record back with `GET /v2/<object>/<_id>?select=refId%20refUrl`, then search it with
`?refId=<value>` and confirm exactly one match. Give the user the `_id` and the `refUrl`.

## Don't

- Put tokens, API keys, passwords or signed links in `refUrl`; anyone who can read the record
  sees it.
- Overwrite a `refId` that already holds a different value without asking; it may belong to
  another integration.
- Store several systems' ids in one `refId` as an object or a joined string.
- Delete a record to "fix" a duplicate; show both to the user and let them decide.

## Writing to an account

Every read and write goes through the helper and the six steps in
[`../_shared/WRITE-FLOW.md`](../_shared/WRITE-FLOW.md). To unlink, update with
`{"refId": null, "refUrl": null}` after its own confirmation. For objects and how they relate,
see the `prolibu-platform-map` skill.
