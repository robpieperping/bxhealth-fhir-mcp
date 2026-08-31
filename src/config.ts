import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// Load .env from the project root (one level up from src/ or dist/) into
// process.env, without pulling in a dependency. Values already present in the
// environment win, so an MCP host or shell export can override the file.
function loadDotEnv(): void {
  const projectRoot = resolve(__dirname, "..");

  let contents: string;
  try {
    contents = readFileSync(resolve(projectRoot, ".env"), "utf8");
  } catch {
    return;
  }

  for (const line of contents.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    const separator = trimmed.indexOf("=");
    if (separator === -1) continue;

    const key = trimmed.slice(0, separator).trim();
    const value = trimmed.slice(separator + 1).trim().replace(/^["']|["']$/g, "");

    if (!(key in process.env)) {
      process.env[key] = value;
    }
  }
}

loadDotEnv();

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `Missing required environment variable ${name}. ` +
        `Copy .env.example to .env and fill in the values.`
    );
  }
  return value;
}

const pingoneEnvironmentId = required("PINGONE_ENV_ID");

function optionalNumber(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`Environment variable ${name} must be a positive integer, got "${raw}".`);
  }
  return parsed;
}

// stdio keeps the original MCP-host registration working (see mcp.json);
// http is what runs in the cluster behind PingGateway.
const transport = process.env.MCP_TRANSPORT ?? "stdio";
if (transport !== "stdio" && transport !== "http") {
  throw new Error(`MCP_TRANSPORT must be "stdio" or "http", got "${transport}".`);
}

export const config = {
  server: {
    transport,
    port: optionalNumber("PORT", 3000),
    host: process.env.HOST ?? "0.0.0.0",
  },
  pingone: {
    environmentId: pingoneEnvironmentId,
    clientId: required("PINGONE_CLIENT_ID"),
    clientSecret: required("PINGONE_CLIENT_SECRET"),
    tokenUrl: `https://auth.pingone.com/${pingoneEnvironmentId}/as/token`,
  },
  fhir: {
    baseUrl: required("FHIR_BASE_URL"),
    version: "R4" as const,
  },
};
