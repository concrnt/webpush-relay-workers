/**
 * Byte/base64 plumbing.
 *
 * Note on header values: an earlier draft of this module also mapped raw
 * bytes 0-255 directly to JS UTF-16 code units ("header byte strings") to
 * try to reproduce Go's byte-exact apns-collapse-id truncation over a real
 * dispatch. That technique round-trips correctly through a plain Node.js
 * http client, but workerd's *actual* outbound fetch() does not treat
 * non-ASCII header values as raw Latin-1 bytes — it re-encodes them as UTF-8
 * on real dispatch (workerd itself warns about this: "we are encoding
 * values as UTF-8 in the header... this would likely result in a TypeError
 * exception" in a browser). That was verified directly against this
 * project's own vitest-pool-workers (workerd) test runner, not assumed. So
 * this module deliberately does NOT provide a byte-string header helper;
 * see apns.ts's `truncateCollapseId` for how the resulting divergence from
 * Go is handled (back off to the nearest valid UTF-8 character boundary
 * instead of truncating mid-character).
 */

/** RFC 4648 §5 base64url, no padding — matches Go's base64.RawURLEncoding. */
export function base64UrlEncode(bytes: Uint8Array): string {
  return bytesToStandardBase64(bytes)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}

function bytesToStandardBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

/** Decodes standard (or unpadded) base64 into bytes. */
export function base64Decode(b64: string): Uint8Array {
  const binary = atob(padBase64(b64));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function padBase64(b64: string): string {
  const remainder = b64.length % 4;
  return remainder === 0 ? b64 : b64 + "=".repeat(4 - remainder);
}

/** Strips PEM armor and whitespace, returning the raw DER bytes. */
export function pemToDer(pem: string): Uint8Array {
  const normalized = pem.replace(/\\n/g, "\n"); // tolerate literal \n surviving env/secret transport
  const body = normalized
    .replace(/-----BEGIN [^-]+-----/, "")
    .replace(/-----END [^-]+-----/, "")
    .replace(/\s+/g, "");
  return base64Decode(body);
}

