/**
 * ≙ webpush-relay/internal/infra/apns/apns.go
 *
 * Forwards a still-encrypted WebPush body to Apple Push Notification
 * service. Never decrypts the payload; decryption happens on-device.
 */
import { base64UrlEncode } from "../../lib/base64";
import {
  Environment,
  Message,
  PayloadTooLargeError,
  UnregisteredError,
  UpstreamError,
  type ApnsSender,
} from "../../usecase/relay";
import { ApnsTokenProvider } from "./token";

/** APNs' hard limit on the total JSON payload size for a standard remote notification. */
const MAX_PAYLOAD_BYTES = 4096;

const FALLBACK_TITLE = "新しい通知があります";

const HOST_PRODUCTION = "https://api.push.apple.com";
const HOST_SANDBOX = "https://api.sandbox.push.apple.com";

const PRIORITY_LOW = 5;
const PRIORITY_HIGH = 10;

export interface ApnsConfig {
  keyPem: string;
  keyId: string;
  teamId: string;
  topic: string; // bundle ID, sent as apns-topic
}

function buildPayload(bodyB64: string): unknown {
  return {
    aps: { alert: { title: FALLBACK_TITLE }, "mutable-content": 1 },
    p: bodyB64,
    e: "aes128gcm",
  };
}

function fallbackPayload(): unknown {
  return { aps: { alert: { title: FALLBACK_TITLE }, "mutable-content": 1 } };
}

function priorityFor(urgency: Message["urgency"]): number {
  return urgency === "very-low" || urgency === "low" ? PRIORITY_LOW : PRIORITY_HIGH;
}

/**
 * Truncates topic to at most 64 UTF-8 bytes, matching the byte (not
 * character) limit of Go's `topic[:64]` byte-slice.
 *
 * DIVERGENCE FROM GO: Go slices raw bytes and may leave an invalid,
 * mid-character UTF-8 tail — harmless for Go's own HTTP/2 client, which
 * sends header values as opaque bytes. Workers' fetch()/Headers API does
 * not offer that: it treats header values as Unicode text, and verified
 * behavior (against this project's own workerd-based test runner, not
 * assumed) shows a "raw byte string" trick does NOT survive a real
 * dispatch — workerd re-encodes non-ASCII "byte" characters as UTF-8 when
 * actually sending the request, which would corrupt rather than preserve
 * Go's raw truncated bytes. So instead, this backs off to the last complete
 * UTF-8 character within the 64-byte budget, producing a valid (if up to 3
 * bytes shorter) string. ASCII topics — the realistic case for a
 * thread/collapse identifier — are completely unaffected either way.
 */
export function truncateCollapseId(topic: string): string {
  const bytes = new TextEncoder().encode(topic);
  if (bytes.length <= 64) return topic;
  for (let len = 64; len > 0; len--) {
    try {
      return new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(
        bytes.subarray(0, len),
      );
    } catch {
      // landed mid-character; back off one byte and try again
    }
  }
  return "";
}

export interface ApnsNotification {
  deviceToken: string;
  topic: string;
  payload: Uint8Array;
  priority: number;
  collapseId: string | undefined;
  expirationUnixSeconds: number | undefined;
}

/**
 * Builds the APNs notification for a message. Applies the 4096-byte
 * fallback (omit "p"/"e" entirely, matching Go's `omitempty`) when the full
 * payload is too large; throws PayloadTooLargeError (no network call) if
 * even the fallback doesn't fit.
 */
export function buildNotification(
  topic: string,
  deviceToken: string,
  msg: Message,
): ApnsNotification {
  const bodyB64 = base64UrlEncode(msg.body);
  let raw = new TextEncoder().encode(JSON.stringify(buildPayload(bodyB64)));
  if (raw.byteLength > MAX_PAYLOAD_BYTES) {
    raw = new TextEncoder().encode(JSON.stringify(fallbackPayload()));
    if (raw.byteLength > MAX_PAYLOAD_BYTES) {
      throw new PayloadTooLargeError();
    }
  }

  return {
    deviceToken,
    topic,
    payload: raw,
    priority: priorityFor(msg.urgency),
    collapseId: msg.topic !== "" ? truncateCollapseId(msg.topic) : undefined,
    expirationUnixSeconds:
      msg.ttl > 0 ? Math.floor(Date.now() / 1000) + msg.ttl : undefined,
  };
}

interface ApnsErrorBody {
  reason?: string;
}

export class ApnsSenderImpl implements ApnsSender {
  private readonly tokenProvider: ApnsTokenProvider;

  constructor(private readonly config: ApnsConfig) {
    this.tokenProvider = new ApnsTokenProvider(config.keyPem, config.keyId, config.teamId);
  }

  async send(env: Environment, deviceToken: string, msg: Message, signal: AbortSignal): Promise<void> {
    const notification = buildNotification(this.config.topic, deviceToken, msg);
    const host = env === "production" ? HOST_PRODUCTION : HOST_SANDBOX;
    const jwt = await this.tokenProvider.getToken();

    const headers: Record<string, string> = {
      authorization: `bearer ${jwt}`,
      "Content-Type": "application/json; charset=utf-8",
      "apns-topic": notification.topic,
      "apns-priority": String(notification.priority),
      "apns-push-type": "alert",
    };
    if (notification.collapseId !== undefined) headers["apns-collapse-id"] = notification.collapseId;
    if (notification.expirationUnixSeconds !== undefined) {
      headers["apns-expiration"] = String(notification.expirationUnixSeconds);
    }

    let response: Response;
    try {
      response = await fetch(`${host}/3/device/${notification.deviceToken}`, {
        method: "POST",
        headers,
        body: notification.payload,
        signal,
      });
    } catch (err) {
      throw UpstreamError.wrap(err);
    }

    if (response.status === 200) return;

    let reason = "";
    try {
      const body = (await response.json()) as ApnsErrorBody;
      reason = body.reason ?? "";
    } catch {
      // unparseable body; fall through with an empty reason
    }

    if (reason === "Unregistered" || reason === "BadDeviceToken" || reason === "ExpiredToken") {
      throw new UnregisteredError();
    }
    if (reason === "PayloadTooLarge") {
      throw new PayloadTooLargeError();
    }
    throw UpstreamError.withDetail(`apns status=${response.status} reason=${reason}`);
  }
}
