import { afterEach, describe, expect, it, vi } from "vitest";
import { base64UrlEncode } from "../src/lib/base64";
import {
  ApnsSenderImpl,
  buildNotification,
  truncateCollapseId,
} from "../src/infra/apns/apns";
import {
  PayloadTooLargeError,
  UnregisteredError,
  UpstreamError,
  type Message,
} from "../src/usecase/relay";
import { generateEcP256Pkcs8Pem } from "./helpers";

function msg(overrides: Partial<Message> = {}): Message {
  return {
    body: new TextEncoder().encode("hello encrypted world"),
    ttl: 0,
    urgency: "normal",
    topic: "",
    ...overrides,
  };
}

describe("buildNotification", () => {
  it("builds the exact expected payload shape", () => {
    const n = buildNotification("world.concrnt.app", "deadbeef", msg());
    expect(n.deviceToken).toBe("deadbeef");
    expect(n.topic).toBe("world.concrnt.app");
    expect(n.priority).toBe(10);
    expect(n.collapseId).toBeUndefined();
    expect(n.expirationUnixSeconds).toBeUndefined();

    const decoded = JSON.parse(new TextDecoder().decode(n.payload));
    expect(decoded).toEqual({
      aps: { alert: { title: "新しい通知があります" }, "mutable-content": 1 },
      p: base64UrlEncode(msg().body),
      e: "aes128gcm",
    });
    expect(decoded.p).not.toContain("=");
  });

  it.each([
    ["very-low", 5],
    ["low", 5],
    ["normal", 10],
    ["high", 10],
  ] as const)("maps urgency %s to priority %d", (urgency, expected) => {
    const n = buildNotification("t", "d", msg({ urgency }));
    expect(n.priority).toBe(expected);
  });

  it("sets expiration only when TTL > 0", () => {
    expect(buildNotification("t", "d", msg({ ttl: 0 })).expirationUnixSeconds).toBeUndefined();
    const before = Math.floor(Date.now() / 1000);
    const n = buildNotification("t", "d", msg({ ttl: 30 }));
    expect(n.expirationUnixSeconds).toBeGreaterThanOrEqual(before + 30);
    expect(n.expirationUnixSeconds).toBeLessThanOrEqual(before + 31);
  });

  it("sets collapseId only when Topic is non-empty, truncated to 64 bytes", () => {
    expect(buildNotification("t", "d", msg({ topic: "" })).collapseId).toBeUndefined();
    const longTopic = "a".repeat(100);
    const n = buildNotification("t", "d", msg({ topic: longTopic }));
    expect(n.collapseId).toBeDefined();
    expect(n.collapseId!.length).toBe(64);
  });

  it("falls back to a p/e-less payload when the full payload exceeds 4096 bytes", () => {
    const bigBody = new Uint8Array(4096);
    const n = buildNotification("t", "d", msg({ body: bigBody }));
    expect(n.payload.byteLength).toBeLessThanOrEqual(4096);
    const decoded = JSON.parse(new TextDecoder().decode(n.payload));
    expect(decoded.p).toBeUndefined();
    expect(decoded.e).toBeUndefined();
    expect(decoded.aps.alert.title).toBe("新しい通知があります");
  });
});

describe("truncateCollapseId", () => {
  it("is a no-op (identity) for short ASCII topics", () => {
    expect(truncateCollapseId("short-topic")).toBe("short-topic");
  });

  it("byte-truncates ASCII topics at exactly 64 bytes (matches Go exactly, 1 byte per char)", () => {
    const topic = "a".repeat(100);
    const truncated = truncateCollapseId(topic);
    expect(truncated).toBe("a".repeat(64));
    expect(new TextEncoder().encode(truncated).length).toBe(64);
  });

  it("backs off to the last complete character when 64 bytes would split a multi-byte character", () => {
    // 3-byte-per-char topic; 64 is not a multiple of 3, so a raw byte cut at
    // 64 would split a character. Go's raw `topic[:64]` byte slice would
    // send that broken tail as opaque bytes; Workers' fetch() cannot
    // reproduce that over a real dispatch (verified against this project's
    // own workerd test runner — non-ASCII "raw byte" header values get
    // re-encoded as UTF-8 on real send, not passed through as bytes), so
    // this implementation instead backs off to a valid character boundary.
    const topic = "あ".repeat(30); // 90 UTF-8 bytes, 3 bytes/char
    const truncated = truncateCollapseId(topic);
    const truncatedBytes = new TextEncoder().encode(truncated);
    expect(truncatedBytes.length).toBeLessThanOrEqual(64);
    expect(truncatedBytes.length).toBeGreaterThan(64 - 3); // backs off at most one character
    // Result must be valid, complete UTF-8 (no thrown error) and a genuine prefix of the topic.
    expect(topic.startsWith(truncated)).toBe(true);
  });

  it("does not truncate when the topic already fits within 64 bytes", () => {
    const topic = "あ".repeat(10); // 30 bytes
    expect(truncateCollapseId(topic)).toBe(topic);
  });
});

describe("ApnsSenderImpl.send", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  async function makeSender() {
    const { pem } = await generateEcP256Pkcs8Pem();
    return new ApnsSenderImpl({
      keyPem: pem,
      keyId: "KEYID12345",
      teamId: "TEAMID12345",
      topic: "world.concrnt.app",
    });
  }

  it("resolves on HTTP 200 and sends the expected request", async () => {
    let capturedRequest: Request | undefined;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      capturedRequest = new Request(input as string, init);
      return new Response(null, { status: 200 });
    });

    const sender = await makeSender();
    await sender.send("production", "deadbeef", msg({ ttl: 30, topic: "thread-1" }), new AbortController().signal);

    expect(capturedRequest).toBeDefined();
    const req = capturedRequest!;
    expect(req.url).toBe("https://api.push.apple.com/3/device/deadbeef");
    expect(req.method).toBe("POST");
    expect(req.headers.get("authorization")).toMatch(/^bearer /);
    expect(req.headers.get("apns-topic")).toBe("world.concrnt.app");
    expect(req.headers.get("apns-push-type")).toBe("alert");
    expect(req.headers.get("apns-priority")).toBe("10");
    expect(req.headers.get("apns-collapse-id")).toBe("thread-1");
    expect(req.headers.get("apns-expiration")).toBeTruthy();
    expect(req.headers.get("Content-Type")).toBe("application/json; charset=utf-8");
  });

  it("uses the sandbox host for the sandbox environment", async () => {
    let capturedUrl = "";
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      capturedUrl = (input as Request).url ?? String(input);
      return new Response(null, { status: 200 });
    });
    const sender = await makeSender();
    await sender.send("sandbox", "deadbeef", msg(), new AbortController().signal);
    expect(capturedUrl).toBe("https://api.sandbox.push.apple.com/3/device/deadbeef");
  });

  it.each(["Unregistered", "BadDeviceToken", "ExpiredToken"])(
    "maps APNs reason %s to UnregisteredError",
    async (reason) => {
      vi.spyOn(globalThis, "fetch").mockResolvedValue(
        new Response(JSON.stringify({ reason }), { status: 410 }),
      );
      const sender = await makeSender();
      await expect(
        sender.send("production", "d", msg(), new AbortController().signal),
      ).rejects.toBeInstanceOf(UnregisteredError);
    },
  );

  it("maps PayloadTooLarge reason to PayloadTooLargeError", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ reason: "PayloadTooLarge" }), { status: 413 }),
    );
    const sender = await makeSender();
    await expect(
      sender.send("production", "d", msg(), new AbortController().signal),
    ).rejects.toBeInstanceOf(PayloadTooLargeError);
  });

  it("maps any other reason to UpstreamError with status/reason in the message", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ reason: "InternalServerError" }), { status: 500 }),
    );
    const sender = await makeSender();
    await expect(
      sender.send("production", "d", msg(), new AbortController().signal),
    ).rejects.toThrow(/apns status=500 reason=InternalServerError/);
  });

  it("wraps a network-level fetch rejection as UpstreamError", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network down"));
    const sender = await makeSender();
    await expect(
      sender.send("production", "d", msg(), new AbortController().signal),
    ).rejects.toBeInstanceOf(UpstreamError);
  });
});
