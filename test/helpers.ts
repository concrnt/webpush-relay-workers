/** Generates throwaway keys for tests — never committed, generated per test run. */

function toPem(der: ArrayBuffer, label: string): string {
  const bytes = new Uint8Array(der);
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  const b64 = btoa(binary);
  const lines = b64.match(/.{1,64}/g) ?? [];
  return `-----BEGIN ${label}-----\n${lines.join("\n")}\n-----END ${label}-----\n`;
}

export async function generateEcP256Pkcs8Pem(): Promise<{ pem: string; publicKey: CryptoKey }> {
  const pair = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  const der = (await crypto.subtle.exportKey("pkcs8", pair.privateKey)) as ArrayBuffer;
  return { pem: toPem(der, "PRIVATE KEY"), publicKey: pair.publicKey };
}

export async function generateRsaPkcs8Pem(): Promise<{ pem: string; publicKey: CryptoKey }> {
  const pair = (await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
  const der = (await crypto.subtle.exportKey("pkcs8", pair.privateKey)) as ArrayBuffer;
  return { pem: toPem(der, "PRIVATE KEY"), publicKey: pair.publicKey };
}

export async function makeFakeServiceAccount(): Promise<{
  json: string;
  publicKey: CryptoKey;
}> {
  const { pem, publicKey } = await generateRsaPkcs8Pem();
  const sa = {
    type: "service_account",
    project_id: "test-project",
    private_key: pem,
    client_email: "test@test-project.iam.gserviceaccount.com",
    token_uri: "https://oauth2.googleapis.com/token",
  };
  return { json: JSON.stringify(sa), publicKey };
}
