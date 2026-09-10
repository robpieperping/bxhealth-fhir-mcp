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

## Deploy

```bash
NS=ping-devops-robpieper
kubectl create secret generic ping-gateway-secrets -n $NS \
  --from-literal=AUTHORIZATION_SERVER_URI="https://auth.pingone.com/<envId>/as" \
  --from-literal=INTROSPECT_URL="https://auth.pingone.com/<envId>/as/introspect" \
  --from-literal=INTROSPECT_CLIENT_ID="<client id>" \
  --from-literal=INTROSPECT_CLIENT_SECRET="<client secret>" \
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
