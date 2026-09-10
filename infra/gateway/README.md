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

## Open items against this AIC realm

Three things the realm does not currently provide, each verified
against its `openid-configuration`:

**`mcp:invoke` is not in `scopes_supported`.** The realm advertises
only `address phone openid profile fr:idm:* am-introspect-all-tokens
email`. `AGENT_FACING_SCOPE` is enforced by `rsFilter`, so until that
scope exists on the OAuth2 provider and is granted to the calling
client, a valid token is still rejected for insufficient scope. Change
the env var if a different scope name is used.

**Nothing sets `aud` to the gateway resource.** `McpProtectionFilter`
matches `resourceIdPointer: "/aud"` against
`https://bxhealth-mcp-gw.ping-devops.com/mcp`, but AM issues `aud` as
the client_id by default, and this realm advertises no resource
indicator (RFC 8707) support. The audience has to come from the OAuth2
provider's audience configuration or a script. The alternative --
repointing `resourceIdPointer` at some other claim -- is not
equivalent: audience-restricting the token to this gateway is the point
of the filter.

**RFC 8693 token exchange is not advertised.** `grant_types_supported`
has no `urn:ietf:params:oauth:grant-type:token-exchange`. Phase 5's
`OAuth2TokenExchangeFilter` and the app's existing
`exchangeDelegationToken` both depend on it, so it needs enabling on
the OAuth2 provider before either works.

**Issuer string carries an explicit port.** Discovery reports the
issuer as `...forgeblocks.com:443/am/...` while the resolvable URL has
no port. The gateway advertises the port-less form. A strict client
comparing `iss` to `authorization_servers` verbatim would see a
mismatch.
