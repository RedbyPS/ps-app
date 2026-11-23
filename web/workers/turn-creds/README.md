# PS relay Worker (Remote screen, From anywhere, PS 1.77)

Not deployed. Deploy only on the developer's yes. The steps are in `~/Projects/ps-handover-notes/remote-anywhere-177.md`.

What it does, text only (the screen picture never comes here):

- `POST /creds`: short lived Cloudflare Realtime TURN credentials (24 hours), made from the TURN key kept here as a secret.
- `GET /room/<32 hex>?role=primary|secondary`: a WebSocket where the two Macs pass a signed offer and a signed answer.
  Nothing is stored. Idle sockets hibernate, so a waiting Mac costs nothing.

Every request is signed with the relay key (HMAC-SHA256 of the time, method, path and body). The key never travels.

Secrets (never in a file): `TURN_KEY_ID`, `TURN_KEY_API_TOKEN`, `PS_RELAY_KEY`.

Tests (no network, no Cloudflare):

```bash
node --test test/worker.test.js
```
