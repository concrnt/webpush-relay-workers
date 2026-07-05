import { importPkcs8Key, signJwt } from "../../lib/jwt";
import { Singleflight } from "../../lib/singleflight";

/**
 * Apple requires the provider JWT to be refreshed no more than once per ~20
 * minutes and no less than once per ~60 minutes. 3000s (50 min) mirrors the
 * Go implementation's cache lifetime (sideshow/apns2's TokenTimeout).
 */
const TOKEN_LIFETIME_MS = 3000 * 1000;

/**
 * Mints and caches the APNs provider JWT (ES256, header {alg,kid}, claims
 * {iss,iat} only — no `typ`/`exp`, matching Apple's token-auth spec exactly).
 * One instance is shared by the production and sandbox senders, mirroring
 * the Go implementation's single shared `token.Token`.
 */
export class ApnsTokenProvider {
  private readonly keyPromise: Promise<CryptoKey>;
  private cached: { jwt: string; issuedAtMs: number } | null = null;
  private readonly flight = new Singleflight<string>();

  constructor(
    keyPem: string,
    private readonly keyId: string,
    private readonly teamId: string,
  ) {
    this.keyPromise = importPkcs8Key(keyPem, "ES256");
  }

  async getToken(nowMs: number = Date.now()): Promise<string> {
    if (this.cached !== null && nowMs - this.cached.issuedAtMs < TOKEN_LIFETIME_MS) {
      return this.cached.jwt;
    }
    return this.flight.do(async () => {
      // Re-check inside the singleflight: another concurrent caller may have
      // just refreshed it while we were waiting to enter.
      if (this.cached !== null && nowMs - this.cached.issuedAtMs < TOKEN_LIFETIME_MS) {
        return this.cached.jwt;
      }
      const iat = Math.floor(nowMs / 1000);
      const jwt = await signJwt(
        { alg: "ES256", kid: this.keyId },
        { iss: this.teamId, iat },
        await this.keyPromise,
        "ES256",
      );
      this.cached = { jwt, issuedAtMs: nowMs };
      return jwt;
    });
  }
}
