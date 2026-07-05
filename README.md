# webpush-relay-workers

A Cloudflare Workers (TypeScript) port of [`webpush-relay`](../webpush-relay)
(Go). Same job, same wire behavior: emulate an RFC 8030 WebPush endpoint and
forward the still-encrypted body to APNs/FCM, never decrypting anything. The
Go version is unaffected — this is a parallel implementation, not a
replacement.

Zero runtime dependencies: all crypto goes through `crypto.subtle`
(WebCrypto), all networking through `fetch`. No `nodejs_compat`, no KV, no
Durable Objects.

## Routes

Identical contract to the Go relay:

- `POST /apns/:environment/:device_token` — `environment` is `production`,
  `sandbox`, or `development` (alias for `sandbox`).
- `POST /fcm/:registration_token`
- `GET /health`

## Setup

```sh
npm install
npm run cf-typegen   # regenerate worker-configuration.d.ts after editing wrangler.jsonc
```

Secrets (never in `wrangler.jsonc`):

```sh
npx wrangler secret put APNS_KEY            # paste the .p8 file contents, including BEGIN/END lines
npx wrangler secret put APNS_KEY_ID
npx wrangler secret put APNS_TEAM_ID
npx wrangler secret put APNS_TOPIC
npx wrangler secret put FCM_SERVICE_ACCOUNT  # paste the whole service-account JSON on one line
```

APNs is only enabled once all four `APNS_*` values are set; FCM is only
enabled once `FCM_SERVICE_ACCOUNT` is set. Either can be configured
independently — the other provider's routes just reply `503` until it is.

For local development, copy [`.dev.vars.example`](./.dev.vars.example) to
`.dev.vars` (gitignored) and fill in real or throwaway values.

## Development

```sh
npm test          # vitest, runs inside workerd via @cloudflare/vitest-pool-workers — no network needed
npm run typecheck # tsc --noEmit
npm run dev       # wrangler dev, local
```

### The APNs-in-local-dev caveat

APNs requires HTTP/2 for its provider API. This works fine once **deployed**,
but local `wrangler dev` (plain, non-`--remote`) can fail to negotiate
outbound HTTP/2 to `api.push.apple.com`/`api.sandbox.push.apple.com` —
this is a known workerd limitation
([cloudflare/workerd#4841](https://github.com/cloudflare/workerd/issues/4841)),
not a bug in this relay. Confirmed directly against this project: a local
`wrangler dev` smoke test against the sandbox host failed with `Network
connection lost` in under half a second, while the exact same request against
a deployed Worker succeeds.

To smoke-test the APNs path end to end, use:

```sh
npx wrangler dev --remote
# or
npx wrangler versions upload   # then curl the printed preview URL
```

FCM has no such issue and works fine under plain local `wrangler dev`.

### Smoke-testing by hand

```sh
curl -i http://localhost:8787/health

curl -i -X POST \
  -H 'Content-Encoding: aes128gcm' -H 'TTL: 30' -H 'Urgency: high' \
  --data-binary @sample-encrypted-body.bin \
  http://localhost:8787/fcm/<registration-token>

# APNs: use --remote or a deployed preview, not plain local dev (see above)
curl -i -X POST \
  -H 'Content-Encoding: aes128gcm' -H 'TTL: 30' \
  --data-binary @sample-encrypted-body.bin \
  https://<preview-or-deployed-host>/apns/sandbox/<device-token>
```

## Deployment

```sh
npx wrangler deploy
```

## Known differences from the Go implementation

1. **Startup validation.** Go validates config and panics at process start
   if credentials are malformed. Workers has no process start — a
   present-but-malformed `FCM_SERVICE_ACCOUNT` is instead detected on first
   use, logged once, and treated as "not configured" (`503`) rather than
   crashing.
2. **FCM 502 message text.** The Go implementation's 502 body for FCM
   errors is formatted by the `firebase-admin` Go SDK internals and can't be
   reproduced exactly; this implementation emits its own stable
   `fcm status=<http> errorCode=<code>` format instead. Status codes and the
   410-vs-502 classification are identical.
3. **apns-collapse-id byte truncation for non-ASCII topics.** Go slices the
   topic to 64 raw bytes (`topic[:64]`), which can split a multi-byte UTF-8
   character and send an invalid trailing byte sequence — harmless for Go's
   own HTTP/2 client, which treats header values as opaque bytes.
   Cloudflare Workers' `fetch()`/`Headers` API does not offer that: header
   values are Unicode text, and (verified directly against this project's
   own workerd-based test runner, not assumed) a "raw byte string" trick
   does **not** survive real dispatch — workerd re-encodes non-ASCII
   "byte" characters as UTF-8 when actually sending a request rather than
   passing the original bytes through. So instead of Go's raw byte
   truncation, this implementation backs off to the last complete UTF-8
   character within the 64-byte budget, which is a valid string that is at
   most 3 bytes shorter than Go's. **ASCII topics (the realistic case for a
   thread/collapse identifier) are completely unaffected** — there is
   nothing to back off from.
4. **TTL values beyond `Number.isSafeInteger`** (±2^53) are treated as
   unset, whereas Go's `strconv.Atoi` accepts values up to ±2^63-1. No
   practical effect on TTL semantics (seconds).

## Architecture

Mirrors the Go project's package layout so the two can be read side by side:

| This project | Go equivalent |
|---|---|
| `src/usecase/relay.ts` | `internal/usecase/relay.go` |
| `src/infra/apns/apns.ts`, `token.ts` | `internal/infra/apns/apns.go` |
| `src/infra/fcm/fcm.ts`, `oauth.ts` | `internal/infra/fcm/fcm.go` |
| `src/infra/config/config.ts` | `internal/infra/config/config.go` |
| `src/present/rest/handler.ts`, `presenter.ts` | `internal/present/rest/handler.go`, `presenter/presenter.go` |
| `src/index.ts` | `cmd/webpush-relay/main.go` |
| `src/lib/{base64,jwt,singleflight}.ts` | (no direct equivalent — Go gets this from `sideshow/apns2`/`golang.org/x/oauth2`/stdlib) |

## Testing

All logic is tested with `@cloudflare/vitest-pool-workers`, so tests run
inside the real workerd runtime (real `crypto.subtle`, real `Headers`
semantics) rather than a Node.js approximation. Outbound `fetch()` calls are
intercepted with `vi.spyOn(globalThis, "fetch")` (the officially demonstrated
pattern for this test runner — see
[workers-sdk's `request-mocking` fixture](https://github.com/cloudflare/workers-sdk/tree/main/fixtures/vitest-pool-workers-examples/request-mocking)),
so no real network calls happen during `npm test`.
