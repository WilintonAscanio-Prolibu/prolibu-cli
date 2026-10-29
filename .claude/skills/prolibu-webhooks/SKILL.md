---
name: prolibu-webhooks
description: Create, change and troubleshoot a Prolibu outbound webhook — an HTTP POST the platform sends to an external system each time a record of an object is created, updated or deleted. Covers choosing the object and event, the destination URL and its owner, trimming the payload to the fields the receiver needs, authenticating the call with a shared-secret header, and what the delivered JSON looks like. Use it whenever someone wants another system notified of changes in Prolibu (sync contacts to a CRM, push won deals to billing, tickets to a help desk), or reports a webhook that delivers nothing or the wrong fields. Spanish triggers: "webhook", "avisar a otro sistema", "notificar cambios", "sincronizar con otro sistema".
---

# Prolibu Webhooks

## What it's for

A Webhook tells Prolibu: "every time a contact (or deal, ticket, any object) is created,
changed or deleted, send the record to this address." The other system learns about the
change within moments, without polling. Delivery is best-effort: there is no retry, so a
receiver that is down misses the event.

## Ask the user first

In plain business terms, before writing anything:

1. **Which object, and which moments?** Created, changed, deleted, or all three.
2. **Where should the notice go?** The exact URL, and who owns that system. Never guess it.
3. **Which fields does the receiving system need?** Usually a handful, plus the record id.
4. **How will the receiver know the call is really from Prolibu?** The default answer is a
   secret header that the receiver checks; agree on its name with the receiver's owner. The
   secret is not the Prolibu API key. Generate it once with
   `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`, or use the value
   the receiver's owner already chose. Show it to the user once, so they can hand it to the
   receiver's owner out-of-band. Then send the webhook body inline with `--data '<json>'`; no
   temp file is needed. Never write it to a repo file and never repeat it later in the conversation.

## Read the reference

**Before building, read `docs/integrations-for-ai-agents/06-webhooks-and-events.md` §1, §4
and §5.** It holds the verified fields, the event names, the payload shapes and
`selectedFields`. If the receiver is a Prolibu Endpoint, also read the `prolibu-endpoints`
skill. Do not work from memory.

## Traps

**Webhooks are off for the account by default.** If the create returns `400` "Webhooks are
disabled", an admin must turn on webhooks in the account preferences. Tell the user; do not
change account preferences yourself.

**Event names and `selectedFields[].entity` use the model name exactly:** `Contact.update`, not
`contact.update`. A wrong case in `entity` is accepted on save but ignored on delivery, so the
whole record goes out.

**`selectedFields` drops `_id` unless you list it.** Always include `_id`, or the receiver
cannot tell which record changed.

**The receiver must re-fetch by id rather than trust the payload.** Anyone who learns the URL
and secret can post a fake body, and an update's `payload` is not a diff: compare
`beforeUpdateDoc` with `afterUpdateDoc`, or read the record again through the API.

**Sandbox accounts never deliver webhooks.** The webhook saves fine and nothing arrives; test on a
non-sandbox account.

**Every update fires, even one that changes nothing.** The receiver must tolerate repeats.

**Several webhooks on the same event can trim each other.** One webhook's `selectedFields`
can shrink what a later one receives. Prefer one webhook per object event.

**The secret header is readable.** Header values are stored in clear text and returned on
every read of the webhook. Never print them in a reply, and rotate them with a `PATCH`.

**A `403` on a webhook.** A 403 usually means the profile's user lacks permission for this;
say so and stop. Don't retry another way.

## Verify

Read the webhook back with `GET /v2/webhook/<_id>` and check `active`, `eventNames` and
`selectedFields`, without showing header values. If the user controls the receiver, ask them
to change one test record and confirm the delivery arrived.

## Don't

- Point a webhook at a URL the user did not give you, or at an internal address.
- Send all fields when the receiver needs a few: set `selectedFields`.
- Use a webhook alone for something that must never be missed; pair it with a scheduled
  reconcile, or use a script on the record event.

## Writing to an account

Every read and write goes through the helper and the six steps in
[`../_shared/WRITE-FLOW.md`](../_shared/WRITE-FLOW.md). For objects and how they relate, see
the `prolibu-platform-map` skill.
