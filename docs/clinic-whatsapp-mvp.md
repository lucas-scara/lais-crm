# Dra. Laís — WhatsApp CRM MVP

## Architecture

```text
WhatsApp Business App
        ↕ Coexistence
Meta WhatsApp Cloud API
        ↓ Webhook Override
Dualhook configuration
        ↓
CRM API /webhooks/whatsapp/<secret>
        ↓
Contact + Activity timeline
```

## MVP behavior

- `messages` → inbound WhatsApp activity.
- `smb_message_echoes` → messages typed by staff in WhatsApp Business.
- `wamid` is stored in Activity.meta and guarded with a Postgres advisory lock.
- WABA and phone-number IDs are checked when configured.
- Contact matching prefers Meta BSUID (`user_id`) and falls back to phone.
- New WhatsApp contacts are created with `enrichmentStatus=SKIPPED`.
  Patient contacts must not be sent through the generic person-enrichment workflow.
- History/contact sync payloads are acknowledged but not imported in this MVP.
- Media binaries are not downloaded; only message type/caption is recorded.

## Required environment variables

```
WHATSAPP_WEBHOOK_VERIFY_TOKEN=<random, at least 16 chars>
WHATSAPP_WEBHOOK_PATH_SECRET=<random, at least 24 chars>
WHATSAPP_WABA_ID=<after Embedded Signup>
WHATSAPP_PHONE_NUMBER_ID=<after Embedded Signup>
WHATSAPP_TEST_ALLOWLIST=<tester phone in E.164 during MVP>
```

Webhook URL:

```
https://<API_HOST>/webhooks/whatsapp/<WHATSAPP_WEBHOOK_PATH_SECRET>
```

## Go-live order

1. Deploy database migrations and API.
2. Sign into the CRM once so an Activity author exists.
3. Create a Dualhook connection with the HTTPS webhook URL and verify token.
4. Use Dualhook Test Ping.
5. Complete Embedded Signup using the existing WhatsApp Business number in Coexistence mode.
6. Do not opt into historic chat import for this MVP.
7. Fill `WHATSAPP_WABA_ID` and `WHATSAPP_PHONE_NUMBER_ID`; redeploy.
8. Set `WHATSAPP_TEST_ALLOWLIST` to the tester's WhatsApp number before
   live message delivery is enabled.
9. Send one inbound test message from that WhatsApp account.
10. Reply from WhatsApp Business and confirm the echo appears on the same Contact timeline.

## Security / privacy constraints

- No webhook secrets are committed.
- No message bodies are written to application logs.
- Patient contacts are not automatically enriched by external research services.
- WhatsApp content is stored in the CRM database and can contain health data.
- Do not enable LLM analysis of patient message bodies until the intended data
  processing and access controls have been reviewed.

## Clinic onboarding difference

This fork intentionally skips the upstream Context.dev/research-key gate. The
workspace onboarding is still required, but the CRM UI is usable without a
person-enrichment provider. This is deliberate for patient/privacy safety.

## Vercel MVP deployment

Only two projects are needed for the first test:

1. **API** — repository root (leave Root Directory blank), Framework **Other**,
   Build Command: `bun apps/api/scripts/build-func.mjs`. Leave Output Directory
   on automatic/default; the script emits Build Output API v3 into
   `.vercel/output`.
2. **App** — Root Directory `apps/app`, Framework **Next.js**.

The separate agent deployment can remain absent until follow-up automation is
introduced.

The API production build applies Prisma migrations automatically when a direct
database URL is available. If `DATABASE_URL` is pooled, set
`DIRECT_DATABASE_URL` to the unpooled connection string.

Set `CRM_TELEMETRY_DISABLED=1` on both projects.

## Test-mode guard

Keep `WHATSAPP_TEST_ALLOWLIST` populated for the whole MVP validation. Events
from other customers are acknowledged with HTTP 200 but are not filed as
contacts or activities. Remove the allowlist only after the deployment,
access-control and privacy posture are deliberately approved for live traffic.
