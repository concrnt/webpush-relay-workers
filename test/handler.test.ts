import { describe, expect, it } from "vitest";
import { handleRequest } from "../src/present/rest/handler";
import {
  PayloadTooLargeError,
  RelayUsecase,
  UnregisteredError,
  UpstreamError,
  type ApnsSender,
  type FcmSender,
  type Message,
} from "../src/usecase/relay";

class FakeApnsSender implements ApnsSender {
  constructor(private readonly err: Error | null = null) {}
  async send(): Promise<void> {
    if (this.err) throw this.err;
  }
}

class FakeFcmSender implements FcmSender {
  constructor(private readonly err: Error | null = null) {}
  async send(): Promise<void> {
    if (this.err) throw this.err;
  }
}

class HangingApnsSender implements ApnsSender {
  async send(_env: unknown, _token: unknown, _msg: Message, signal: AbortSignal): Promise<void> {
    return new Promise((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
    });
  }
}

function req(path: string, init: RequestInit = {}): Request {
  return new Request(`https://relay.example.com${path}`, init);
}

const VALID_HEADERS = { "Content-Encoding": "aes128gcm" };

async function bodyJson(res: Response): Promise<unknown> {
  return JSON.parse(await res.text());
}

describe("GET /health", () => {
  it("returns 200 ok", async () => {
    const relay = new RelayUsecase(null, null);
    const res = await handleRequest(req("/health"), relay);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ok");
  });
});

describe("unmatched routes", () => {
  it("404s an unknown path", async () => {
    const relay = new RelayUsecase(null, null);
    const res = await handleRequest(req("/unknown"), relay);
    expect(res.status).toBe(404);
  });

  it("405s a wrong method on a known route", async () => {
    const relay = new RelayUsecase(null, null);
    const res = await handleRequest(req("/apns/production/token", { method: "GET" }), relay);
    expect(res.status).toBe(405);
  });
});

describe("POST /apns/:environment/:device_token", () => {
  it("returns 201 with an empty body on success", async () => {
    const relay = new RelayUsecase(new FakeApnsSender(), null);
    const res = await handleRequest(
      req("/apns/production/deadbeef", {
        method: "POST",
        headers: VALID_HEADERS,
        body: "encrypted",
      }),
      relay,
    );
    expect(res.status).toBe(201);
    expect(await res.text()).toBe("");
  });

  it("accepts the development alias for sandbox", async () => {
    const relay = new RelayUsecase(new FakeApnsSender(), null);
    const res = await handleRequest(
      req("/apns/development/deadbeef", { method: "POST", headers: VALID_HEADERS, body: "x" }),
      relay,
    );
    expect(res.status).toBe(201);
  });

  it("400s an unknown environment", async () => {
    const relay = new RelayUsecase(new FakeApnsSender(), null);
    const res = await handleRequest(
      req("/apns/staging/deadbeef", { method: "POST", headers: VALID_HEADERS, body: "x" }),
      relay,
    );
    expect(res.status).toBe(400);
    expect(await bodyJson(res)).toEqual({ error: "unknown environment: staging" });
  });

  it("415s a wrong Content-Encoding, echoing the value", async () => {
    const relay = new RelayUsecase(new FakeApnsSender(), null);
    const res = await handleRequest(
      req("/apns/production/deadbeef", {
        method: "POST",
        headers: { "Content-Encoding": "aesgcm" },
        body: "x",
      }),
      relay,
    );
    expect(res.status).toBe(415);
    expect(await bodyJson(res)).toEqual({ error: "unsupported Content-Encoding: aesgcm" });
  });

  it("415s a missing Content-Encoding with an empty echoed value", async () => {
    const relay = new RelayUsecase(new FakeApnsSender(), null);
    const res = await handleRequest(
      req("/apns/production/deadbeef", { method: "POST", body: "x" }),
      relay,
    );
    expect(res.status).toBe(415);
    expect(await bodyJson(res)).toEqual({ error: "unsupported Content-Encoding: " });
  });

  it("400s an empty body", async () => {
    const relay = new RelayUsecase(new FakeApnsSender(), null);
    const res = await handleRequest(
      req("/apns/production/deadbeef", { method: "POST", headers: VALID_HEADERS }),
      relay,
    );
    expect(res.status).toBe(400);
    expect(await bodyJson(res)).toEqual({ error: "body must not be empty" });
  });

  it("accepts exactly 8192 bytes but rejects 8193", async () => {
    const relay = new RelayUsecase(new FakeApnsSender(), null);
    const ok = await handleRequest(
      req("/apns/production/deadbeef", {
        method: "POST",
        headers: VALID_HEADERS,
        body: new Uint8Array(8192),
      }),
      relay,
    );
    expect(ok.status).toBe(201);

    const tooBig = await handleRequest(
      req("/apns/production/deadbeef", {
        method: "POST",
        headers: VALID_HEADERS,
        body: new Uint8Array(8193),
      }),
      relay,
    );
    expect(tooBig.status).toBe(400);
    expect(await bodyJson(tooBig)).toEqual({
      error: "failed to read body: http: request body too large",
    });
  });

  it("503s when APNs is not configured", async () => {
    const relay = new RelayUsecase(null, null);
    const res = await handleRequest(
      req("/apns/production/deadbeef", { method: "POST", headers: VALID_HEADERS, body: "x" }),
      relay,
    );
    expect(res.status).toBe(503);
    expect(await bodyJson(res)).toEqual({ error: "provider not configured" });
  });

  it("410s with the fixed message when the sender reports Unregistered", async () => {
    const relay = new RelayUsecase(new FakeApnsSender(new UnregisteredError()), null);
    const res = await handleRequest(
      req("/apns/production/deadbeef", { method: "POST", headers: VALID_HEADERS, body: "x" }),
      relay,
    );
    expect(res.status).toBe(410);
    expect(await bodyJson(res)).toEqual({ error: "subscription is no longer valid" });
  });

  it("413s when the sender reports payload too large", async () => {
    const relay = new RelayUsecase(new FakeApnsSender(new PayloadTooLargeError()), null);
    const res = await handleRequest(
      req("/apns/production/deadbeef", { method: "POST", headers: VALID_HEADERS, body: "x" }),
      relay,
    );
    expect(res.status).toBe(413);
  });

  it("502s on any other upstream error", async () => {
    const relay = new RelayUsecase(new FakeApnsSender(UpstreamError.withDetail("boom")), null);
    const res = await handleRequest(
      req("/apns/production/deadbeef", { method: "POST", headers: VALID_HEADERS, body: "x" }),
      relay,
    );
    expect(res.status).toBe(502);
  });

  it("504s with the exact deadline message when the sender hangs past the timeout", async () => {
    const relay = new RelayUsecase(new HangingApnsSender(), null);
    const promise = handleRequest(
      req("/apns/production/deadbeef", { method: "POST", headers: VALID_HEADERS, body: "x" }),
      relay,
    );
    const res = await promise;
    expect(res.status).toBe(504);
    expect(await bodyJson(res)).toEqual({ error: "context deadline exceeded" });
  }, 15_000);
});

describe("POST /fcm/:registration_token", () => {
  it("returns 201 with an empty body on success", async () => {
    const relay = new RelayUsecase(null, new FakeFcmSender());
    const res = await handleRequest(
      req("/fcm/reg-token", { method: "POST", headers: VALID_HEADERS, body: "x" }),
      relay,
    );
    expect(res.status).toBe(201);
  });

  it("503s when FCM is not configured", async () => {
    const relay = new RelayUsecase(null, null);
    const res = await handleRequest(
      req("/fcm/reg-token", { method: "POST", headers: VALID_HEADERS, body: "x" }),
      relay,
    );
    expect(res.status).toBe(503);
  });

  it("410s on UnregisteredError", async () => {
    const relay = new RelayUsecase(null, new FakeFcmSender(new UnregisteredError()));
    const res = await handleRequest(
      req("/fcm/reg-token", { method: "POST", headers: VALID_HEADERS, body: "x" }),
      relay,
    );
    expect(res.status).toBe(410);
  });

  it("502s on UpstreamError", async () => {
    const relay = new RelayUsecase(null, new FakeFcmSender(UpstreamError.withDetail("boom")));
    const res = await handleRequest(
      req("/fcm/reg-token", { method: "POST", headers: VALID_HEADERS, body: "x" }),
      relay,
    );
    expect(res.status).toBe(502);
  });
});

describe("Urgency / TTL parsing", () => {
  it.each(["very-low", "low", "high"])("passes through a recognized Urgency %s", async (urgency) => {
    let captured: Message | undefined;
    const relay = new RelayUsecase(
      {
        async send(_env, _token, msg) {
          captured = msg;
        },
      },
      null,
    );
    await handleRequest(
      req("/apns/production/deadbeef", {
        method: "POST",
        headers: { ...VALID_HEADERS, Urgency: urgency },
        body: "x",
      }),
      relay,
    );
    expect(captured?.urgency).toBe(urgency);
  });

  it("defaults unrecognized/absent Urgency to normal", async () => {
    let captured: Message | undefined;
    const relay = new RelayUsecase(
      {
        async send(_env, _token, msg) {
          captured = msg;
        },
      },
      null,
    );
    await handleRequest(
      req("/apns/production/deadbeef", {
        method: "POST",
        headers: { ...VALID_HEADERS, Urgency: "nonsense" },
        body: "x",
      }),
      relay,
    );
    expect(captured?.urgency).toBe("normal");
  });

  it("parses a valid integer TTL", async () => {
    let captured: Message | undefined;
    const relay = new RelayUsecase(
      {
        async send(_env, _token, msg) {
          captured = msg;
        },
      },
      null,
    );
    await handleRequest(
      req("/apns/production/deadbeef", {
        method: "POST",
        headers: { ...VALID_HEADERS, TTL: "30" },
        body: "x",
      }),
      relay,
    );
    expect(captured?.ttl).toBe(30);
  });

  // Note: a literal leading/trailing space (e.g. " 5") is not a meaningful
  // case here — HTTP header parsing (both Go's net/http and Workers' fetch)
  // strips optional surrounding whitespace before handlers ever see the
  // value, so it never reaches parseGoInt as " 5" in either implementation.
  it.each(["abc", "1.5", "1e3", ""])(
    "silently treats invalid TTL %s as unset (0)",
    async (ttl) => {
      let captured: Message | undefined;
      const relay = new RelayUsecase(
        {
          async send(_env, _token, msg) {
            captured = msg;
          },
        },
        null,
      );
      await handleRequest(
        req("/apns/production/deadbeef", {
          method: "POST",
          headers: { ...VALID_HEADERS, TTL: ttl },
          body: "x",
        }),
        relay,
      );
      expect(captured?.ttl).toBe(0);
    },
  );

  it("treats a negative TTL as unset for downstream purposes (stored, but <= 0)", async () => {
    let captured: Message | undefined;
    const relay = new RelayUsecase(
      {
        async send(_env, _token, msg) {
          captured = msg;
        },
      },
      null,
    );
    await handleRequest(
      req("/apns/production/deadbeef", {
        method: "POST",
        headers: { ...VALID_HEADERS, TTL: "-5" },
        body: "x",
      }),
      relay,
    );
    expect(captured?.ttl).toBeLessThanOrEqual(0);
  });
});
