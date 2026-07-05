import { afterEach, describe, expect, it, vi } from "vitest";
import { base64UrlEncode } from "../src/lib/base64";
import { buildMessage, FcmSenderImpl } from "../src/infra/fcm/fcm";
import { PayloadTooLargeError, UnregisteredError, UpstreamError, type Message } from "../src/usecase/relay";
import { makeFakeServiceAccount } from "./helpers";

function msg(overrides: Partial<Message> = {}): Message {
  return {
    body: new TextEncoder().encode("hello encrypted world"),
    ttl: 0,
    urgency: "normal",
    topic: "",
    ...overrides,
  };
}

describe("buildMessage", () => {
  it("builds a data-only message with no `notification` field", () => {
    const m = buildMessage("reg-token", msg());
    expect(m.token).toBe("reg-token");
    expect(m.data).toEqual({ p: base64UrlEncode(msg().body), e: "aes128gcm" });
    expect(m.data.p).not.toContain("=");
    expect((m as unknown as Record<string, unknown>).notification).toBeUndefined();
    expect(m.android.priority).toBe("high");
  });

  it.each([
    ["very-low", "normal"],
    ["low", "normal"],
    ["normal", "high"],
    ["high", "high"],
  ] as const)("maps urgency %s to android priority %s", (urgency, expected) => {
    expect(buildMessage("t", msg({ urgency })).android.priority).toBe(expected);
  });

  it("sets ttl only when TTL > 0, formatted as '<N>s'", () => {
    expect(buildMessage("t", msg({ ttl: 0 })).android.ttl).toBeUndefined();
    expect(buildMessage("t", msg({ ttl: 30 })).android.ttl).toBe("30s");
  });

  it("sets collapse_key from Topic, WITHOUT truncation (unlike APNs)", () => {
    const longTopic = "a".repeat(100);
    const m = buildMessage("t", msg({ topic: longTopic }));
    expect(m.android.collapse_key).toBe(longTopic);
    expect(m.android.collapse_key!.length).toBe(100);
  });

  it("omits collapse_key when Topic is empty", () => {
    expect(buildMessage("t", msg({ topic: "" })).android.collapse_key).toBeUndefined();
  });

  it("falls back to data={e} only when the data object exceeds 4096 bytes", () => {
    const bigBody = new Uint8Array(4096);
    const m = buildMessage("t", msg({ body: bigBody }));
    expect(m.data).toEqual({ e: "aes128gcm" });
  });
});

describe("FcmSenderImpl.send", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  async function makeSender(dryRun = false) {
    const { json } = await makeFakeServiceAccount();
    const serviceAccount = JSON.parse(json);
    return new FcmSenderImpl({ serviceAccount, dryRun });
  }

  function mockOauthThenFcm(fcmStatus: number, fcmBody: unknown) {
    let oauthCalls = 0;
    const capturedFcmRequests: Request[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const req = new Request(input as string, init);
      if (req.url === "https://oauth2.googleapis.com/token") {
        oauthCalls++;
        return new Response(JSON.stringify({ access_token: "fake-access-token", expires_in: 3600 }), {
          status: 200,
        });
      }
      capturedFcmRequests.push(req.clone());
      return new Response(JSON.stringify(fcmBody), { status: fcmStatus });
    });
    return { oauthCallCount: () => oauthCalls, capturedFcmRequests };
  }

  it("resolves on success and sends the expected FCM request", async () => {
    const { capturedFcmRequests } = mockOauthThenFcm(200, { name: "projects/test-project/messages/1" });
    const sender = await makeSender();
    await sender.send("reg-token", msg({ ttl: 30, topic: "thread-1" }), new AbortController().signal);

    expect(capturedFcmRequests).toHaveLength(1);
    const req = capturedFcmRequests[0]!;
    expect(req.url).toBe("https://fcm.googleapis.com/v1/projects/test-project/messages:send");
    expect(req.headers.get("Authorization")).toBe("Bearer fake-access-token");
    const body = JSON.parse(await req.text());
    expect(body.validate_only).toBeUndefined();
    expect(body.message.token).toBe("reg-token");
    expect(body.message.android.collapse_key).toBe("thread-1");
    expect(body.message.android.ttl).toBe("30s");
  });

  it("wraps the body in validate_only when dryRun is configured", async () => {
    const { capturedFcmRequests } = mockOauthThenFcm(200, { name: "x" });
    const sender = await makeSender(true);
    await sender.send("reg-token", msg(), new AbortController().signal);
    const body = JSON.parse(await capturedFcmRequests[0]!.text());
    expect(body.validate_only).toBe(true);
  });

  it("caches the OAuth2 access token across sequential sends", async () => {
    const { oauthCallCount } = mockOauthThenFcm(200, { name: "x" });
    const sender = await makeSender();
    await sender.send("t1", msg(), new AbortController().signal);
    await sender.send("t2", msg(), new AbortController().signal);
    expect(oauthCallCount()).toBe(1);
  });

  it("shares a single in-flight OAuth2 exchange across concurrent sends", async () => {
    const { oauthCallCount } = mockOauthThenFcm(200, { name: "x" });
    const sender = await makeSender();
    await Promise.all([
      sender.send("t1", msg(), new AbortController().signal),
      sender.send("t2", msg(), new AbortController().signal),
      sender.send("t3", msg(), new AbortController().signal),
    ]);
    expect(oauthCallCount()).toBe(1);
  });

  it.each(["UNREGISTERED", "INVALID_ARGUMENT"])(
    "maps FcmError errorCode %s to UnregisteredError",
    async (errorCode) => {
      mockOauthThenFcm(404, {
        error: {
          details: [{ "@type": "type.googleapis.com/google.firebase.fcm.v1.FcmError", errorCode }],
        },
      });
      const sender = await makeSender();
      await expect(
        sender.send("t", msg(), new AbortController().signal),
      ).rejects.toBeInstanceOf(UnregisteredError);
    },
  );

  it("maps other errors to UpstreamError", async () => {
    mockOauthThenFcm(500, {
      error: {
        details: [{ "@type": "type.googleapis.com/google.firebase.fcm.v1.FcmError", errorCode: "INTERNAL" }],
      },
    });
    const sender = await makeSender();
    await expect(sender.send("t", msg(), new AbortController().signal)).rejects.toThrow(
      /fcm status=500 errorCode=INTERNAL/,
    );
  });

  it("does not classify a bare top-level INVALID_ARGUMENT status (no FcmError detail) as unregistered", async () => {
    mockOauthThenFcm(400, { error: { status: "INVALID_ARGUMENT", message: "bad request" } });
    const sender = await makeSender();
    const err = await sender
      .send("t", msg(), new AbortController().signal)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UpstreamError);
    expect(err).not.toBeInstanceOf(UnregisteredError);
  });

  it("wraps a network-level fetch rejection during send as UpstreamError", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = typeof input === "string" ? input : (input as Request).url;
      if (url === "https://oauth2.googleapis.com/token") {
        return new Response(JSON.stringify({ access_token: "t", expires_in: 3600 }), { status: 200 });
      }
      throw new Error("network down");
    });
    const sender = await makeSender();
    await expect(
      sender.send("t", msg(), new AbortController().signal),
    ).rejects.toBeInstanceOf(UpstreamError);
  });

  it("wraps an oauth2 token-exchange failure as UpstreamError", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("nope", { status: 401 }));
    const sender = await makeSender();
    await expect(
      sender.send("t", msg(), new AbortController().signal),
    ).rejects.toBeInstanceOf(UpstreamError);
  });
});
