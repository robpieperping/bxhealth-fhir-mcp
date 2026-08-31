import type { Request, Response } from "express";
import { config } from "./config.js";
import { getCapabilityStatement } from "./fhir-client.js";
import { SERVER_NAME, SERVER_VERSION } from "./server.js";

/**
 * Liveness. Deliberately does NOT touch FHIR or require a token: it answers
 * "is this process up", nothing more. A FHIR outage must not restart the pod.
 */
export function healthz(_req: Request, res: Response): void {
  res.status(200).json({
    status: "ok",
    server: SERVER_NAME,
    version: SERVER_VERSION,
    fhirVersion: config.fhir.version,
  });
}

/**
 * Readiness. Pings the FHIR server's CapabilityStatement, so a pod that
 * cannot reach FHIR is pulled out of the Service rather than serving tool
 * calls that are all going to fail.
 *
 * Also reports the fhirVersion the server actually advertises, which is the
 * cheapest way to catch an R4-server/R5-server mismatch.
 */
export async function readyz(_req: Request, res: Response): Promise<void> {
  try {
    const capability = (await getCapabilityStatement()) as { fhirVersion?: string };
    const reported = capability?.fhirVersion;
    res.status(200).json({
      status: "ready",
      fhir: {
        baseUrl: config.fhir.baseUrl,
        expectedVersion: config.fhir.version,
        reportedVersion: reported ?? "unknown",
        versionMatches: reported ? reported.startsWith("4.") : null,
      },
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    res.status(503).json({
      status: "not-ready",
      reason: "fhir-unreachable",
      detail: message,
    });
  }
}
