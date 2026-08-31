import axios, { AxiosInstance, AxiosResponse } from "axios";
import { config } from "./config.js";
import { getAccessToken, clearTokenCache } from "./auth.js";

export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export interface FhirRequestOptions {
  method: HttpMethod;
  path: string;
  body?: unknown;
  params?: Record<string, string | string[]>;
  headers?: Record<string, string>;
  /** Skip authentication for publicly accessible endpoints (e.g. /metadata) */
  skipAuth?: boolean;
}

export interface FhirSearchParams {
  resourceType: string;
  searchParams?: Record<string, string | string[]>;
  count?: number;
  offset?: number;
  sort?: string;
  includes?: string[];
  revIncludes?: string[];
  summary?: "true" | "text" | "data" | "count" | "false";
  elements?: string[];
}

function buildAxiosInstance(): AxiosInstance {
  return axios.create({
    baseURL: config.fhir.baseUrl,
    headers: {
      Accept: "application/fhir+json",
      "Content-Type": "application/fhir+json",
      Prefer: "return=representation",
    },
    timeout: 30_000,
  });
}

async function fhirRequest<T = unknown>(options: FhirRequestOptions): Promise<T> {
  const client = buildAxiosInstance();

  const authHeaders: Record<string, string> = {};
  if (!options.skipAuth) {
    const token = await getAccessToken();
    // Only attach Authorization header if a token was successfully obtained.
    // If null, proceed without auth (FHIR server may allow unauthenticated access).
    if (token) {
      authHeaders.Authorization = `Bearer ${token}`;
    }
  }

  const requestConfig = {
    method: options.method,
    url: options.path,
    headers: {
      ...authHeaders,
      ...options.headers,
    },
    params: options.params,
    data: options.body,
  };

  try {
    const response = await client.request<T>(requestConfig);
    return response.data;
  } catch (error: unknown) {
    throw formatFhirError(error);
  }
}

function formatFhirError(error: unknown): Error {
  if (axios.isAxiosError(error)) {
    const status = error.response?.status;
    const operationOutcome = error.response?.data;
    const message =
      typeof operationOutcome === "object" &&
      operationOutcome !== null &&
      "issue" in operationOutcome
        ? JSON.stringify(operationOutcome, null, 2)
        : error.message;
    return new Error(`FHIR request failed (HTTP ${status}): ${message}`);
  }
  return error instanceof Error ? error : new Error(String(error));
}

// ── Resource CRUD ─────────────────────────────────────────────────────────────

export async function readResource(resourceType: string, id: string): Promise<unknown> {
  return fhirRequest({ method: "GET", path: `/${resourceType}/${id}` });
}

export async function vreadResource(
  resourceType: string,
  id: string,
  versionId: string
): Promise<unknown> {
  return fhirRequest({ method: "GET", path: `/${resourceType}/${id}/_history/${versionId}` });
}

export async function createResource(resourceType: string, body: unknown): Promise<unknown> {
  return fhirRequest({ method: "POST", path: `/${resourceType}`, body });
}

export async function updateResource(
  resourceType: string,
  id: string,
  body: unknown
): Promise<unknown> {
  return fhirRequest({ method: "PUT", path: `/${resourceType}/${id}`, body });
}

export async function patchResource(
  resourceType: string,
  id: string,
  patchBody: unknown,
  patchType: "json-patch" | "fhir-patch" = "json-patch"
): Promise<unknown> {
  const contentType =
    patchType === "json-patch"
      ? "application/json-patch+json"
      : "application/fhir+json";
  return fhirRequest({
    method: "PATCH",
    path: `/${resourceType}/${id}`,
    body: patchBody,
    headers: { "Content-Type": contentType },
  });
}

export async function deleteResource(resourceType: string, id: string): Promise<unknown> {
  return fhirRequest({ method: "DELETE", path: `/${resourceType}/${id}` });
}

// ── Search ────────────────────────────────────────────────────────────────────

export async function searchResource(opts: FhirSearchParams): Promise<unknown> {
  const params: Record<string, string | string[]> = { ...opts.searchParams };

  if (opts.count !== undefined) params["_count"] = String(opts.count);
  if (opts.offset !== undefined) params["_offset"] = String(opts.offset);
  if (opts.sort) params["_sort"] = opts.sort;
  if (opts.summary) params["_summary"] = opts.summary;
  if (opts.elements?.length) params["_elements"] = opts.elements.join(",");
  if (opts.includes?.length) params["_include"] = opts.includes;
  if (opts.revIncludes?.length) params["_revinclude"] = opts.revIncludes;

  return fhirRequest({
    method: "GET",
    path: `/${opts.resourceType}`,
    params,
  });
}

export async function searchPost(
  resourceType: string,
  searchParams: Record<string, string | string[]>
): Promise<unknown> {
  return fhirRequest({
    method: "POST",
    path: `/${resourceType}/_search`,
    body: new URLSearchParams(
      Object.entries(searchParams).flatMap(([k, v]) =>
        Array.isArray(v) ? v.map((val): [string, string] => [k, val]) : [[k, v] as [string, string]]
      )
    ).toString(),
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
  });
}

// ── History ───────────────────────────────────────────────────────────────────

export async function getResourceHistory(
  resourceType: string,
  id: string,
  count?: number,
  since?: string
): Promise<unknown> {
  const params: Record<string, string> = {};
  if (count !== undefined) params["_count"] = String(count);
  if (since) params["_since"] = since;
  return fhirRequest({
    method: "GET",
    path: `/${resourceType}/${id}/_history`,
    params,
  });
}

export async function getTypeHistory(
  resourceType: string,
  count?: number,
  since?: string
): Promise<unknown> {
  const params: Record<string, string> = {};
  if (count !== undefined) params["_count"] = String(count);
  if (since) params["_since"] = since;
  return fhirRequest({ method: "GET", path: `/${resourceType}/_history`, params });
}

// ── Operations ────────────────────────────────────────────────────────────────

export async function getCapabilityStatement(): Promise<unknown> {
  // /metadata is publicly accessible on most FHIR servers — no token required
  return fhirRequest({ method: "GET", path: "/metadata", skipAuth: true });
}

export async function executeOperation(
  operation: string,
  resourceType?: string,
  id?: string,
  body?: unknown
): Promise<unknown> {
  const parts = [resourceType, id, `$${operation}`].filter(Boolean);
  return fhirRequest({
    method: body !== undefined ? "POST" : "GET",
    path: `/${parts.join("/")}`,
    body,
  });
}

export async function executeTransaction(bundle: unknown): Promise<unknown> {
  return fhirRequest({ method: "POST", path: "/", body: bundle });
}

export async function getPatientEverything(
  patientId: string,
  params?: Record<string, string>
): Promise<unknown> {
  return fhirRequest({
    method: "GET",
    path: `/Patient/${patientId}/$everything`,
    params,
  });
}

export async function validateResource(
  resourceType: string,
  body: unknown,
  profile?: string
): Promise<unknown> {
  const params: Record<string, string> = {};
  if (profile) params["profile"] = profile;
  return fhirRequest({
    method: "POST",
    path: `/${resourceType}/$validate`,
    body,
    params,
  });
}
