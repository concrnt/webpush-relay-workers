import { describe, expect, it } from "vitest";
import { base64Decode, base64UrlEncode, pemToDer } from "../src/lib/base64";
import { importPkcs8Key, signJwt } from "../src/lib/jwt";
import { generateEcP256Pkcs8Pem, generateRsaPkcs8Pem } from "./helpers";

describe("base64UrlEncode", () => {
  it("produces no padding and URL-safe alphabet", () => {
    // bytes chosen so standard base64 would need '+', '/', and '=' padding
    const bytes = new Uint8Array([0xfb, 0xff, 0xfe]);
    const encoded = base64UrlEncode(bytes);
    expect(encoded).not.toContain("+");
    expect(encoded).not.toContain("/");
    expect(encoded).not.toContain("=");
    expect(encoded).toBe("-__-");
  });

  it("round-trips through base64Decode for various lengths mod 3", () => {
    for (let len = 0; len < 10; len++) {
      const bytes = new Uint8Array(len).map((_, i) => i * 7 + 1);
      const encoded = base64UrlEncode(bytes);
      const standard = encoded.replaceAll("-", "+").replaceAll("_", "/");
      expect(Array.from(base64Decode(standard))).toEqual(Array.from(bytes));
    }
  });
});

describe("pemToDer", () => {
  it("strips armor and whitespace", async () => {
    const { pem } = await generateEcP256Pkcs8Pem();
    const der = pemToDer(pem);
    expect(der.length).toBeGreaterThan(0);
    // re-importing must succeed, proving the DER bytes are intact
    await expect(
      crypto.subtle.importKey("pkcs8", der, { name: "ECDSA", namedCurve: "P-256" }, false, [
        "sign",
      ]),
    ).resolves.toBeDefined();
  });

  it("tolerates literal backslash-n sequences (as can survive secret transport)", async () => {
    const { pem } = await generateEcP256Pkcs8Pem();
    const withLiteralNewlines = pem.replace(/\n/g, "\\n");
    const der1 = pemToDer(pem);
    const der2 = pemToDer(withLiteralNewlines);
    expect(Array.from(der2)).toEqual(Array.from(der1));
  });
});

describe("signJwt", () => {
  it("produces an ES256 JWT with exactly the given header/claims and a verifiable signature", async () => {
    const { pem, publicKey } = await generateEcP256Pkcs8Pem();
    const key = await importPkcs8Key(pem, "ES256");

    const header = { alg: "ES256", kid: "KEYID12345" };
    const claims = { iss: "TEAMID12345", iat: 1700000000 };
    const jwt = await signJwt(header, claims, key, "ES256");

    const [h, c, sig] = jwt.split(".");
    expect(JSON.parse(atob(h!.replaceAll("-", "+").replaceAll("_", "/")))).toEqual(header);
    expect(JSON.parse(atob(c!.replaceAll("-", "+").replaceAll("_", "/")))).toEqual(claims);
    // no extra claims/headers slipped in (no `typ`, no `exp`)
    expect(Object.keys(JSON.parse(atob(h!.replaceAll("-", "+").replaceAll("_", "/"))))).toEqual([
      "alg",
      "kid",
    ]);

    const sigBytes = base64Decode(sig!.replaceAll("-", "+").replaceAll("_", "/"));
    expect(sigBytes.length).toBe(64); // raw r||s, not ASN.1/DER

    const signingInput = `${h}.${c}`;
    const valid = await crypto.subtle.verify(
      { name: "ECDSA", hash: "SHA-256" },
      publicKey,
      sigBytes,
      new TextEncoder().encode(signingInput),
    );
    expect(valid).toBe(true);
  });

  it("produces a verifiable RS256 JWT", async () => {
    const { pem, publicKey } = await generateRsaPkcs8Pem();
    const key = await importPkcs8Key(pem, "RS256");

    const header = { alg: "RS256", typ: "JWT" };
    const claims = { iss: "svc@example.com", scope: "x", aud: "y", iat: 1, exp: 2 };
    const jwt = await signJwt(header, claims, key, "RS256");
    const [h, c, sig] = jwt.split(".");
    const sigBytes = base64Decode(sig!.replaceAll("-", "+").replaceAll("_", "/"));

    const valid = await crypto.subtle.verify(
      "RSASSA-PKCS1-v1_5",
      publicKey,
      sigBytes,
      new TextEncoder().encode(`${h}.${c}`),
    );
    expect(valid).toBe(true);
  });
});
