# PingGateway in front of bxhealth-fhir-mcp

The gateway is the public MCP endpoint at
`https://bxhealth-mcp-gw.ping-devops.com/mcp`. The MCP server has no
Ingress; only the gateway reaches it, at `http://bxhealth-fhir-mcp`.

Image: `cjmuir710/pinggateway:2026.3.0` (linux/arm64). Verified to
contain `openig-mcp-2026.3.0.jar` (`McpProtectionFilter`,
`McpValidationFilter`) and `openig-ping-2026.3.0.jar`
(`PingAuthorizeFilter`), so it covers the policy work in Phase 7 too.
There is no public PingGateway image from Ping; this one is a
third-party build of the licensed distribution.

## Authorization server: PingOne Advanced Identity Cloud

The issuer is the AIC tenant's AM realm, not PingOne:

```
https://openam-bxhealthaz.forgeblocks.com/am/oauth2/realms/root/realms/alpha
```

This is the same issuer the FHIR server advertises in its SMART
`oauth-uris`, which is what makes the on-behalf-of hop in Phase 5
possible at all.

The gateway authenticates to AM as the **agent** registered in the AIC
console under Gateways and Agents (`BxHealthGatewayID`). Verified
behaviour of that identity:

| Operation | Result |
| --- | --- |
| `POST /introspect` with HTTP Basic | **works** — this is all the gateway needs |
| `POST /access_token` `grant_type=client_credentials` | `unauthorized_client` — the agent is authenticated but not allowed to mint tokens |

So the agent can validate tokens but cannot issue them. Anything that
needs to *obtain* a token (a test client, the Phase 5 backend hop) needs
a separate OAuth 2.0 client in the alpha realm.

## Deploy

```bash
NS=ping-devops-robpieper
ISS="https://openam-bxhealthaz.forgeblocks.com/am/oauth2/realms/root/realms/alpha"
kubectl create secret generic ping-gateway-secrets -n $NS \
  --from-literal=AUTHORIZATION_SERVER_URI="$ISS" \
  --from-literal=INTROSPECT_URL="$ISS/introspect" \
  --from-literal=INTROSPECT_CLIENT_ID="BxHealthGatewayID" \
  --from-literal=INTROSPECT_CLIENT_SECRET="<agent password>" \
  --from-literal=AGENT_FACING_SCOPE="mcp:invoke"

kubectl create configmap ping-gateway-config -n $NS \
  --from-file=admin.json=infra/gateway/config/admin.json \
  --from-file=00-health.json=infra/gateway/config/routes/00-health.json \
  --from-file=mcp-fhir.json=infra/gateway/config/routes/mcp-fhir.json \
  --dry-run=client -o yaml | kubectl apply -n $NS -f -

kubectl apply -n $NS -f infra/gateway/k8s.yaml
kubectl rollout restart -n $NS deploy/ping-gateway   # after any config change
```

## Verify

```bash
curl -s https://bxhealth-mcp-gw.ping-devops.com/gw-health
curl -s https://bxhealth-mcp-gw.ping-devops.com/.well-known/oauth-protected-resource/mcp | jq
curl -si -X POST https://bxhealth-mcp-gw.ping-devops.com/mcp \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' | head -3   # expect 401
```

A correct 401 carries
`WWW-Authenticate: Bearer resource_metadata="…/.well-known/oauth-protected-resource/mcp"`.
That header is how an MCP client discovers where to authenticate, so
losing it silently breaks client onboarding even though the gateway
still "works".

## Things that cost time, so they are written down

**`requireHttps` defaults to true, and TLS terminates at the Ingress.**
Left at the default, every request to `/mcp` returns a bare `403` with
an empty body and no `WWW-Authenticate` — identical whether the token
is missing, invalid or valid, and with nothing in the logs. The
gateway only ever sees plain HTTP from nginx, so `requireHttps: false`
on `OAuth2ResourceServerFilter` is required here. This is the single
most misleading failure in the setup.

**`authorizationServerUri` is the ISSUER, not the introspection
endpoint.** It is published verbatim in
`/.well-known/oauth-protected-resource` as `authorization_servers`, and
clients fetch `<that>/.well-known/openid-configuration` from it. Ping's
own reference config in the image passes the introspection URL, which
produces metadata that no client can follow. Introspection has its own
`endpoint` on the token resolver; keep the two separate.

**The instance directory must be a fresh `emptyDir`.** PingGateway
writes `tmp/ig.pid` at startup and refuses to start if it already
exists (`Identity Gateway PID file already exists`). A restart against
a persistent volume fails permanently. `emptyDir` is not a convenience
here, it is what makes restarts work.

**Do not copy the vendor reference config's secret handling.** It ships
`Base64EncodedSecretStore` with real client secrets inline, in a
publicly pullable image. This config uses `SystemAndEnvSecretStore`
against a Kubernetes Secret instead. With `"format": "PLAIN"` a
`clientSecretId` is uppercased and dots become underscores:
`introspect.client.secret` -> `INTROSPECT_CLIENT_SECRET`.

**`capture: "all"` is absent deliberately.** The reference config sets
it; it logs full request and response bodies including `Authorization`
headers.

**The image has no curl or wget.** To debug connectivity from inside
the pod, use the bundled JDK: write a small `Probe.java` to
`/var/gateway/tmp` and run `/opt/jdk/bin/java Probe.java`.

## Test client

`BxHealthAIAgentClientID` mints tokens for testing. Note the auth
method: this client is **`client_secret_post`**, not basic — basic
returns `invalid_client - Invalid authentication method`, which reads
like a wrong password but is not.

```bash
ISS="https://openam-bxhealthaz.forgeblocks.com/am/oauth2/realms/root/realms/alpha"
curl -sS -X POST "$ISS/access_token" \
  -d 'grant_type=client_credentials&scope=mcp:invoke&client_id=BxHealthAIAgentClientID&client_secret=<secret>'
```

Requesting no scope returns the client's full grant:
`mcp:invoke patient/*.read openid profile fhirUser`.

## The one thing still blocking end-to-end

`McpProtectionFilter` reads `resourceIdPointer` from the **token
introspection response**, and AM's introspection response has no `aud`
field at all. The error is exact:

```
WWW-Authenticate: Bearer error="invalid_token",
  error_description="Access token does not contain an '/aud' claim."
```

The JWT itself does carry `aud`, but it is the client_id
(`BxHealthAIAgentClientID`), not the gateway resource — AM's default.
Verified that AM ignores `audience`, `resource` and `aud` request
parameters, so the audience cannot be asked for at token time; it has
to be set on the OAuth2 provider (audience configuration or an access
token modification script).

Two things must both be true before a real token passes:

1. AM issues `aud` = `https://bxhealth-mcp-gw.ping-devops.com/mcp`.
2. That audience is visible **in the introspection response**, not just
   in the JWT. If AM will not expose it there, swap
   `TokenIntrospectionAccessTokenResolver` for a JWKS-based
   `StatelessAccessTokenResolver` so the filter reads the JWT's own
   claims. That trades revocation checking for claim visibility.

Everything downstream of that check is already proven — see below.

## Verified end to end

With `McpProtectionFilter` temporarily lifted (token still validated by
AM introspection, scope still enforced), the whole chain works through
the public URL:

- `initialize` -> 200, session opened on the MCP server
- `tools/list` -> all 19 tools
- `fhir_search_patients` -> live patient data from SmileCDR

So AM token validation, scope enforcement, MCP protocol validation, the
reverse proxy hop, and the backend are all good. The audience binding is
the only gap.

`McpValidationFilter` also enforces the MCP spec properly: a
post-initialize request without `MCP-Protocol-Version: 2025-06-18` is
rejected `-32600 Invalid Request`. Include that header in any manual
test after initialize.

## Other open items against this AIC realm

**`mcp:invoke` is not in the realm's `scopes_supported`** (it advertises
only `address phone openid profile fr:idm:* am-introspect-all-tokens
email`), but tokens carry it anyway, so it is granted at client level.
Not a blocker; just do not expect discovery to list it.

**RFC 8693 token exchange is not advertised.** `grant_types_supported`
has no `urn:ietf:params:oauth:grant-type:token-exchange`. Phase 5's
`OAuth2TokenExchangeFilter` and the app's existing
`exchangeDelegationToken` both depend on it, so it needs enabling on
the OAuth2 provider before either works.

**`resourceId` must be an absolute URI.** Passing a bare identifier
fails the route at build time with a NullPointerException from
`org.forgerock.openig.mcp.ResourceId` — and a route that fails to build
just returns 404, which looks like a routing mistake rather than a
config error. Check the pod log for "An error occurred while building
the route" whenever `/mcp` unexpectedly 404s.

**Issuer string carries an explicit port.** Discovery reports the
issuer as `...forgeblocks.com:443/am/...` while the resolvable URL has
no port. The gateway advertises the port-less form. A strict client
comparing `iss` to `authorization_servers` verbatim would see a
mismatch.
