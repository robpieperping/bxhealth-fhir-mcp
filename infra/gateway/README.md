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

Tokens are validated **statelessly**, by verifying the JWT signature
against the realm's JWK set, not by calling `/introspect`. AM's
introspection response carries no `aud` field at all, so
`McpProtectionFilter` had nothing to read; the JWT itself does carry
`aud`. See "Why stateless" below.

A consequence worth noting: the gateway no longer needs the AIC agent
(`BxHealthGatewayID`) at all, and `ping-gateway-secrets` no longer
holds any credential. The agent remains the right identity if this is
ever switched back to introspection — it introspects successfully over
HTTP Basic, though it is refused `client_credentials` with
`unauthorized_client`, so it can validate tokens but never issue them.

## Deploy

```bash
NS=ping-devops-robpieper
ISS="https://openam-bxhealthaz.forgeblocks.com/am/oauth2/realms/root/realms/alpha"
kubectl create secret generic ping-gateway-secrets -n $NS \
  --from-literal=AUTHORIZATION_SERVER_URI="$ISS" \
  --from-literal=TOKEN_ISSUER="https://openam-bxhealthaz.forgeblocks.com:443/am/oauth2/realms/root/realms/alpha" \
  --from-literal=JWK_SET_URI="$ISS/connect/jwk_uri" \
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

## Why stateless, and the three gotchas in configuring it

`McpProtectionFilter` reads `resourceIdPointer` from whatever the
access token resolver returns. With
`TokenIntrospectionAccessTokenResolver` that is AM's introspection
response, which carries **no `aud` field at all**, so the filter failed
every token with `Access token does not contain an '/aud' claim.` The
JWT does carry `aud`, so `StatelessAccessTokenResolver` — verifying the
signature against the realm's JWK set — is what makes the claim
visible.

The trade is revocation: a stateless check cannot see that a token was
revoked before it expires. Tokens here are short-lived (3600s), which
is the usual mitigation.

Three things to get right:

1. **The property is `jwkUrl`, not `jwkSetUri`.** The 2026 reference
   documentation for `StatelessAccessTokenResolver` shows `jwkSetUri`;
   this build rejects it with
   `/heap/0/config/secretsProvider/config/jwkUrl: Expecting a value`.
2. **`issuer` must match the token's `iss` byte for byte, including the
   port.** AM reports its issuer as
   `...forgeblocks.com:443/am/...` while the browsable URL has no port.
   That is why `TOKEN_ISSUER` is a separate variable from
   `AUTHORIZATION_SERVER_URI` rather than reusing it.
3. **`verificationSecretId` is ignored** when the secrets provider is
   `JwkSetSecretStore` (the key is selected by the JWT's `kid`), but it
   still has to be present and non-empty.

## The one thing still blocking end-to-end

The audience *value*. AM issues `aud` as the client_id
(`BxHealthAIAgentClientID`), not the gateway resource, and it ignores
`audience`, `resource` and `aud` request parameters — verified — so it
cannot be asked for at token time. It has to be set on the OAuth2
provider, via its audience configuration or an access token
modification script, to:

```
https://bxhealth-mcp-gw.ping-devops.com/mcp
```

Until then a valid token is refused with `Access Token resource ID does
not match the expected one.` Note this is a *different* and much more
specific error than before the resolver change: signature, issuer and
scope now all pass, and only the audience comparison fails.

Everything downstream of that check is already proven — see below.

## Verified end to end

Three outcomes are cleanly distinguishable, which is how you can tell
the resolver is doing real work:

| Request | Response |
| --- | --- |
| no token | 401, bare `Bearer resource_metadata="…"` |
| tampered signature | 401 `invalid_token`, generic description |
| valid token, wrong `aud` | 401 `Access Token resource ID does not match the expected one.` |

With `McpProtectionFilter` temporarily lifted (token still validated
against AM, scope still enforced), the whole chain works through
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
