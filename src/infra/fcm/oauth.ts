import { importPkcs8Key, signJwt } from "../../lib/jwt";
import { Singleflight } from "../../lib/singleflight";
import { UpstreamError } from "../../usecase/relay";

export interface ServiceAccount {
  client_email: string;
  private_key: string;
  project_id: string;
  token_uri?: string;
}

const SCOPE = "https://www.googleapis.com/auth/firebase.messaging";
const DEFAULT_TOKEN_URI = "https://oauth2.googleapis.com/token";
/** Refresh a bit before the token's actual expiry to avoid using one that
 * expires mid-flight. */
const EXPIRY_MARGIN_MS = 60_000;

interface TokenResponse {
  access_token: string;
  expires_in: number;
}

/**
 * Exchanges a Google service-account RS256 JWT assertion for an OAuth2
 * access token (the "jwt-bearer" grant), caching the result for its
 * lifetime (~60 min). Concurrent callers on a cold/expired cache share a
 * single token exchange rather than each starting their own.
 */
export class GoogleAccessTokenProvider {
  private readonly keyPromise: Promise<CryptoKey>;
  private cached: { token: string; expiresAtMs: number } | null = null;
  private readonly flight = new Singleflight<string>();

  constructor(private readonly serviceAccount: ServiceAccount) {
    this.keyPromise = importPkcs8Key(serviceAccount.private_key, "RS256");
  }

  async getAccessToken(signal?: AbortSignal): Promise<string> {
    const now = Date.now();
    if (this.cached !== null && now < this.cached.expiresAtMs - EXPIRY_MARGIN_MS) {
      return this.cached.token;
    }
    return this.flight.do(async () => {
      if (this.cached !== null && now < this.cached.expiresAtMs - EXPIRY_MARGIN_MS) {
        return this.cached.token;
      }

      const iat = Math.floor(Date.now() / 1000);
      const aud = this.serviceAccount.token_uri ?? DEFAULT_TOKEN_URI;
      const assertion = await signJwt(
        { alg: "RS256", typ: "JWT" },
        {
          iss: this.serviceAccount.client_email,
          scope: SCOPE,
          aud,
          iat,
          exp: iat + 3600,
        },
        await this.keyPromise,
        "RS256",
      );

      let response: Response;
      try {
        response = await fetch(aud, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
            assertion,
          }),
          signal,
        });
      } catch (err) {
        throw UpstreamError.wrap(err);
      }

      if (!response.ok) {
        throw UpstreamError.withDetail(`oauth2 token exchange failed: status=${response.status}`);
      }

      const body = (await response.json()) as TokenResponse;
      this.cached = { token: body.access_token, expiresAtMs: Date.now() + body.expires_in * 1000 };
      return body.access_token;
    });
  }
}
