# Model gateway requirements

The pill uses a pre-existing `local-model-switch` protocol version 2 gateway.
This address is separate from the Harness chat host. Chat deletion never calls it.

| Endpoint | Purpose |
| --- | --- |
| `GET /local-switch/models` | Version, stable gateway UUID, complete model catalog |
| `GET /local-switch/status` | Active/loading/desired model, phase, readiness, request counts |
| `POST /local-switch/prepare` | Explicit load request with an allowlisted model ID |
| `/v1/*` | Inference API used by the Harness provider |

The host bridge sends a private bearer credential and pinned
`x-local-model-gateway-id` as applicable. Renderer responses contain no key.
Credentials must not follow redirects to other origins.

`plugins/dsh-model-switcher/catalog.mjs` defines the model IDs and context/reply caps. Installation
rejects incomplete or mismatched catalogs. The server must serialize loading,
let active responses finish, and reject inactive-model inference instead of
silently loading it.

Use a trusted private network or HTTPS. The existing Windows gateway admits
private IPv4 clients on its configured port (commonly 8083); firewall/reachability
are host setup responsibilities. No real IP, credential, or UUID is shipped.
