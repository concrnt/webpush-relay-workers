import { base64UrlEncode, pemToDer } from "./base64";

export type JwtAlg = "ES256" | "RS256";

/**
 * Imports a PKCS8 PEM private key for JWT signing. Apple's .p8 files and
 * Google service-account `private_key` fields are both PKCS8 PEM, so this
 * single function covers both APNs (ES256/P-256) and FCM (RS256).
 */
export async function importPkcs8Key(pem: string, alg: JwtAlg): Promise<CryptoKey> {
  const der = pemToDer(pem);
  if (alg === "ES256") {
    return crypto.subtle.importKey(
      "pkcs8",
      der,
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["sign"],
    );
  }
  return crypto.subtle.importKey(
    "pkcs8",
    der,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );
}

/**
 * Signs a compact JWS (header.claims.signature) with the given key/alg. The
 * caller controls the exact header/claims objects — e.g. APNs's JWT must
 * have ONLY {alg,kid} and {iss,iat}, no `typ`/`exp`, to match the Go
 * implementation exactly.
 *
 * WebCrypto's ECDSA signature is already the raw 64-byte r||s format JWS
 * requires, unlike most non-browser crypto APIs (which default to ASN.1/DER
 * and need explicit re-encoding) — no conversion needed here.
 */
export async function signJwt(
  header: Record<string, unknown>,
  claims: Record<string, unknown>,
  key: CryptoKey,
  alg: JwtAlg,
): Promise<string> {
  const enc = new TextEncoder();
  const signingInput =
    `${base64UrlEncode(enc.encode(JSON.stringify(header)))}.` +
    `${base64UrlEncode(enc.encode(JSON.stringify(claims)))}`;
  const signature = await crypto.subtle.sign(
    alg === "ES256" ? { name: "ECDSA", hash: "SHA-256" } : "RSASSA-PKCS1-v1_5",
    key,
    enc.encode(signingInput),
  );
  return `${signingInput}.${base64UrlEncode(new Uint8Array(signature))}`;
}
