# bxhealth-fhir-mcp

MCP server exposing tools for a FHIR R4 server, authenticated against PingOne
via the OAuth 2.0 client_credentials flow.

Runs over **stdio** (an MCP host spawns the process) or **Streamable HTTP**
(a long-running service, which is how it runs in Kubernetes behind
PingGateway). Derived from `fhirmcpserver`; see
`bxhealth-demo-base/docs/mcp-gateway-program-plan.md` for the wider design.

## Configuration

All configuration comes from environment variables. Copy the example file and
fill in your own values:

```bash
cp .env.example .env
```

| Variable | Description |
| --- | --- |
| `PINGONE_ENV_ID` | PingOne environment ID (also used to build the token URL) |
| `PINGONE_CLIENT_ID` | PingOne client ID |
| `PINGONE_CLIENT_SECRET` | PingOne client secret |
| `FHIR_BASE_URL` | FHIR R4 base URL, including the `/fhir` path |
| `MCP_TRANSPORT` | `stdio` (default) or `http` |
| `PORT` | HTTP port, default `3000` (http transport only) |
| `HOST` | HTTP bind address, default `0.0.0.0` (http transport only) |

`.env` is read at startup from the project root. Variables already set in the
environment take precedence, so an MCP host or shell export can override the
file. `.env` is gitignored — never commit real credentials.

The PingOne application must have the `client_credentials` grant enabled and use
`client_secret_basic` authentication. If a token cannot be obtained, requests
are attempted without an `Authorization` header.

## Build and run

```bash
npm install
npm run build
npm start          # stdio
npm run start:http # Streamable HTTP on PORT (default 3000)
```

For development with live TypeScript:

```bash
npm run dev        # stdio
npm run dev:http   # Streamable HTTP
```

## HTTP transport

| Route | Purpose |
| --- | --- |
| `POST /mcp` | JSON-RPC requests. A request with no `Mcp-Session-Id` must be an `initialize`; the response carries the new session id. |
| `GET /mcp` | The SSE stream for an established session. |
| `DELETE /mcp` | Ends a session. |
| `GET /healthz` | Liveness. Never touches FHIR, so a FHIR outage cannot restart the pod. |
| `GET /readyz` | Readiness. Pings the FHIR CapabilityStatement and reports the `fhirVersion` the server advertises, which is the cheapest way to catch an R4/R5 mismatch. |

Sessions are held in memory, so the HTTP service is **single-replica** unless
sticky sessions or a shared session store are added first.

Smoke test:

```bash
curl -sS -X POST http://localhost:3000/mcp \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"curl","version":"1.0.0"}}}'
```

Or point the MCP Inspector at `http://localhost:3000/mcp`:

```bash
npx @modelcontextprotocol/inspector
```

## Container

```bash
docker build -f infra/Dockerfile -t bxhealth-fhir-mcp .
docker run --rm -p 3000:3000 --env-file .env bxhealth-fhir-mcp
```

The image defaults to `MCP_TRANSPORT=http` and runs as the non-root `node`
user.

## Registering with an MCP host

`mcp.json` shows the stdio server registration:

```json
{
  "mcpServers": {
    "bxhealth-fhir-mcp": {
      "command": "node",
      "args": ["/absolute/path/to/bxhealth-fhir-mcp/dist/index.js"]
    }
  }
}
```

Adjust the path to wherever you cloned the project.

## Tools

Generic FHIR operations:

- `fhir_get_metadata` — fetch the server CapabilityStatement
- `fhir_read_resource` / `fhir_vread_resource` — read a resource, optionally at a version
- `fhir_search_resources` — search any resource type
- `fhir_create_resource` / `fhir_update_resource` / `fhir_patch_resource` / `fhir_delete_resource`
- `fhir_resource_history` / `fhir_type_history` — history for one resource or a whole type
- `fhir_validate_resource` — validate a resource against the server's profiles
- `fhir_execute_operation` — invoke an arbitrary `$operation`
- `fhir_transaction` — submit a transaction or batch Bundle
- `fhir_patient_everything` — `Patient/$everything`

Convenience searches:

- `fhir_search_patients`
- `fhir_search_observations`
- `fhir_search_conditions`
- `fhir_search_medication_requests`
- `fhir_search_encounters`
