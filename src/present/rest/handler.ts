/** ≙ webpush-relay/internal/present/rest/handler.go */
import {
  DeadlineExceededError,
  Environment,
  Message,
  NotConfiguredError,
  PayloadTooLargeError,
  RelayUsecase,
  UnregisteredError,
  Urgency,
} from "../../usecase/relay";
import * as presenter from "./presenter";

const APNS_RE = /^\/apns\/([^/]+)\/([^/]+)$/;
const FCM_RE = /^\/fcm\/([^/]+)$/;

/** ≙ handler.go's upstreamTimeout. */
const UPSTREAM_TIMEOUT_MS = 10_000;
/** ≙ handler.go's maxBodyBytes. */
const MAX_BODY_BYTES = 8 * 1024;

export async function handleRequest(request: Request, relay: RelayUsecase): Promise<Response> {
  const path = new URL(request.url).pathname;

  if (path === "/health") {
    if (request.method !== "GET") return presenter.methodNotAllowed();
    return new Response("ok");
  }

  const apnsMatch = APNS_RE.exec(path);
  if (apnsMatch) {
    if (request.method !== "POST") return presenter.methodNotAllowed();
    return handleApns(
      request,
      relay,
      decodeURIComponent(apnsMatch[1]!),
      decodeURIComponent(apnsMatch[2]!),
    );
  }

  const fcmMatch = FCM_RE.exec(path);
  if (fcmMatch) {
    if (request.method !== "POST") return presenter.methodNotAllowed();
    return handleFcm(request, relay, decodeURIComponent(fcmMatch[1]!));
  }

  return presenter.notFound();
}

function parseEnvironment(raw: string): Environment | null {
  switch (raw) {
    case "production":
      return "production";
    case "sandbox":
    case "development":
      return "sandbox";
    default:
      return null;
  }
}

function parseUrgency(raw: string | null): Urgency {
  if (raw === "very-low" || raw === "low" || raw === "high") return raw;
  return "normal";
}

/** ≙ strconv.Atoi — rejects anything that isn't a plain (optionally signed) integer literal. */
function parseGoInt(raw: string): number | null {
  if (!/^[+-]?\d+$/.test(raw)) return null;
  const n = Number(raw);
  return Number.isSafeInteger(n) ? n : null;
}

function parseTtl(raw: string | null): number {
  if (raw === null) return 0;
  return parseGoInt(raw) ?? 0; // invalid/absent TTL is silently ignored, matching Go
}

type ParsedMessage = { ok: true; message: Message } | { ok: false; response: Response };

async function parseMessage(request: Request): Promise<ParsedMessage> {
  const encoding = request.headers.get("Content-Encoding") ?? "";
  if (encoding !== "aes128gcm") {
    return {
      ok: false,
      response: presenter.unsupportedMediaType(`unsupported Content-Encoding: ${encoding}`),
    };
  }

  const body = new Uint8Array(await request.arrayBuffer());
  if (body.byteLength > MAX_BODY_BYTES) {
    return {
      ok: false,
      response: presenter.badRequestMessage("failed to read body: http: request body too large"),
    };
  }
  if (body.byteLength === 0) {
    return { ok: false, response: presenter.badRequestMessage("body must not be empty") };
  }

  return {
    ok: true,
    message: {
      body,
      ttl: parseTtl(request.headers.get("TTL")),
      urgency: parseUrgency(request.headers.get("Urgency")),
      topic: request.headers.get("Topic") ?? "",
    },
  };
}

async function handleApns(
  request: Request,
  relay: RelayUsecase,
  environmentRaw: string,
  deviceToken: string,
): Promise<Response> {
  const environment = parseEnvironment(environmentRaw);
  if (environment === null) {
    return presenter.badRequestMessage(`unknown environment: ${environmentRaw}`);
  }
  if (deviceToken === "") {
    return presenter.badRequestMessage("device_token must not be empty");
  }

  const parsed = await parseMessage(request);
  if (!parsed.ok) return parsed.response;

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);
  try {
    await relay.relayApns(environment, deviceToken, parsed.message, controller.signal);
    return presenter.created();
  } catch (err) {
    return respondError(err, controller.signal);
  } finally {
    clearTimeout(timeoutId);
  }
}

async function handleFcm(
  request: Request,
  relay: RelayUsecase,
  registrationToken: string,
): Promise<Response> {
  if (registrationToken === "") {
    return presenter.badRequestMessage("registration_token must not be empty");
  }

  const parsed = await parseMessage(request);
  if (!parsed.ok) return parsed.response;

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);
  try {
    await relay.relayFcm(registrationToken, parsed.message, controller.signal);
    return presenter.created();
  } catch (err) {
    return respondError(err, controller.signal);
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * ≙ handler.go's respond(). The AbortSignal is checked first: however the
 * underlying sender happened to wrap/report the abort (its exact error type
 * varies), a fired 10s deadline always means 504 with the exact Go message.
 */
function respondError(err: unknown, signal: AbortSignal): Response {
  if (signal.aborted) return presenter.gatewayTimeout("context deadline exceeded");
  if (err instanceof NotConfiguredError) return presenter.serviceUnavailable(err.message);
  if (err instanceof UnregisteredError) return presenter.gone("subscription is no longer valid");
  if (err instanceof PayloadTooLargeError) return presenter.payloadTooLarge(err.message);
  if (err instanceof DeadlineExceededError) return presenter.gatewayTimeout(err.message);
  const message = err instanceof Error ? err.message : String(err);
  return presenter.badGateway(message);
}
