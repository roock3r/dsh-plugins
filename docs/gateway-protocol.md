# Model gateway requirements

The pill uses a pre-existing `local-model-switch` protocol version 2 gateway.
This address is separate from the Harness chat host. Chat deletion never calls it.

| Endpoint | Purpose |
| --- | --- |
| `GET /local-switch/models` | Version, stable gateway UUID, currently available model catalog |
| `GET /local-switch/status` | Active/loading/desired model, phase, readiness, request counts |
| `POST /local-switch/prepare` | Explicit load request with an allowlisted model ID |
| `/v1/*` | Inference API used by the Harness provider |

The host bridge sends a private bearer credential and pinned
`x-local-model-gateway-id` as applicable. Renderer responses contain no key.
Credentials must not follow redirects to other origins.

Each catalog response has `gateway: "local-model-switch"`, `version: 2`, a stable
`gatewayId`, and a `models` array. Each model supplies `id`, `name`, `contextWindow`,
`maxTokens`, `input` (currently text), and optional `reasoningEfforts`. A
non-reasoning model uses `reasoningEfforts: false`; an off-only reasoning map is
not a valid Harness model declaration. Names are model names, independent of the
client's chosen host label. The client validates a bounded metadata allowlist;
server data cannot change provider URLs, authentication, or headers.

The managed provider explicitly uses system messages (not the developer role),
`max_tokens`, and OpenAI-style reasoning effort. Pill selection chooses thinking
off when supported, or the lowest declared effort; non-reasoning models receive
no explicit effort. There is no incompatible provider-wide thinking default. This
keeps LAN-hosted requests consistent with the working local gateway profile;
generic OpenAI auto-detection can otherwise choose different wire fields.

The server filters the selectable array using configured load/chat recipes and
read-only backend availability checks. An offline backend, missing model, or
disabled recipe must not be advertised as selectable. It may return separate
`unavailable` and `candidates` diagnostics, but these do not grant load access.
An empty list is valid at runtime; installation requires at least one available
model. Client polling never requests a load. Legacy v2 hosts that return a static
catalog still need a server update to provide availability filtering.

The existing Windows host uses Strata recipes for Flash and Ollama recipes for
the dense 27B models. Its private `state/model-switch-models.json` can register
additional supported Ollama recipes; discovery then checks whether those models
are installed. Unregistered Ollama tags are candidates only. No local paths or
keys belong in this public package.

The server must serialize loading,
let active responses finish, and reject inactive-model inference instead of
silently loading it.

Use a trusted private network or HTTPS. The existing Windows gateway admits
private IPv4 clients on its configured port (commonly 8083); firewall/reachability
are host setup responsibilities. No real IP, credential, or UUID is shipped.
