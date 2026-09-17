# Fala

Private Brazilian Portuguese learning hub for Dan. Existing curriculum and supplied September lesson logs are preserved.

## Runtime

The existing dependency-free frontend is served by a Cloudflare-compatible Worker. Sites supplies the owner-private access gate, authenticated-user headers, and the `DB` D1 binding. Every API reads the authenticated owner; writes and WebSocket connections reject cross-site origins. The standard API key stays in the `OPENAI_API_KEY` site secret.

Secure activation: configure `OPENAI_API_KEY` as a secret through Sites, then deploy to apply the environment revision. Missing credentials leave live voice disabled. No demo lessons, costs, or API keys are seeded. Never put a key in the browser or repository.

## Lessons

Browser WebRTC carries audio directly to OpenAI Realtime. A separate authenticated WebSocket through the Worker observes API usage and executes lesson tools. The microphone remains muted and model auto-response stays disabled until that saving connection is ready. The model records practice evidence after each assessed phrase. A disconnect closes the paid voice connection and finalizes existing checkpoints. Stale sessions can be recovered on the next visit. Raw audio is not stored by Fala.

GPT-Realtime-2.1 is the default; Mini is selectable. GPT-5.6 Luna writes a structured log and adaptive next plan, with a deterministic checkpoint-based fallback. Independent retrieval and spontaneous conversation on separate days are required for automatic mastery. Failed or prompted retrieval keeps the phrase developing. No practice evidence means the prior next plan is retained.

Notebook saves use revision checks. The initial browser notebook is imported once; local legacy backups and offline drafts are retained. Conflicting device edits require a choice instead of overwriting saved notes.

## Costs

`usage_events` records API response IDs exactly once. Realtime audio, text, cached tokens, and output/reasoning tokens are priced separately; note-generation usage is included. USD values are calculated using rates pinned to 16 September 2026. AUD conversion defaults to the 15 September RBA rate and is editable. The totals are estimates, not an invoice; interrupted or unclassified usage is flagged as potentially incomplete. No historical API cost is inferred for imported lesson logs.

The monthly budget starts at A$60. Server-side checks run before sessions and periodically during them. A response in flight and final notes may slightly exceed it. The limit does not cover other applications using the API project. Sessions have a 55-minute maximum and can be resumed as another lesson.

## Maintenance

- `npm test`: preservation, authorization, revision conflicts, actual SQLite schema, cost accounting, lesson recovery, simulated server voice events, and frontend boot.
- `npm run db:generate`: generate append-only Drizzle migrations after a schema change.
- `npm run build`: bundle the Worker with current public assets and migration metadata.
- Publish through Sites using the existing project identity.

Verification without a key covers application logic and simulated API events. A real microphone lesson, model availability, actual billing reconciliation, Bluetooth, and phone-lock behaviour still require a configured API project and device testing. No claim of live audio verification is made before that test.
