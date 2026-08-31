import axios from "axios";
import { config } from "./config.js";

interface TokenResponse {
  access_token: string;
  token_type: string;
  expires_in: number;
  scope?: string;
}

interface CachedToken {
  accessToken: string;
  expiresAt: number;
}

let cachedToken: CachedToken | null = null;

/**
 * Retrieves a valid access token using PingOne client_credentials flow
 * with client_secret_basic authentication (credentials in Authorization header).
 * Caches the token and refreshes it 30 seconds before expiry.
 *
 * Returns null if the token cannot be obtained (e.g. PingOne app not configured
 * with client_credentials grant or missing scopes). In that case callers should
 * attempt the FHIR request without an Authorization header.
 */
export async function getAccessToken(): Promise<string | null> {
  const now = Date.now();

  if (cachedToken && cachedToken.expiresAt > now + 30_000) {
    return cachedToken.accessToken;
  }

  const { clientId, clientSecret, tokenUrl } = config.pingone;

  // PingOne requires client_secret_basic: credentials go in the Authorization header,
  // not in the POST body (client_secret_post is not supported for this app).
  const basicCredentials = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");

  try {
    const response = await axios.post<TokenResponse>(
      tokenUrl,
      "grant_type=client_credentials",
      {
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Authorization: `Basic ${basicCredentials}`,
        },
      }
    );

    const { access_token, expires_in } = response.data;

    cachedToken = {
      accessToken: access_token,
      expiresAt: now + expires_in * 1000,
    };

    return access_token;
  } catch (err: unknown) {
    // Log the auth failure but allow callers to proceed without a token.
    // This supports FHIR servers that permit unauthenticated access.
    const detail = axios.isAxiosError(err)
      ? JSON.stringify(err.response?.data ?? err.message)
      : String(err);
    console.error(`[auth] Failed to obtain access token (will proceed without auth): ${detail}`);
    return null;
  }
}

/** Clears the cached token, forcing a fresh token on the next request. */
export function clearTokenCache(): void {
  cachedToken = null;
}
