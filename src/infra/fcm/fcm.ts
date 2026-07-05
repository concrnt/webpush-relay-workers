/**
 * ≙ webpush-relay/internal/infra/fcm/fcm.go
 *
 * Forwards a still-encrypted WebPush body to Firebase Cloud Messaging as a
 * data-only message. Never decrypts the payload; decryption happens
 * on-device.
 */
import { base64UrlEncode } from "../../lib/base64";
import {
  Message,
  PayloadTooLargeError,
  UnregisteredError,
  UpstreamError,
  type FcmSender,
} from "../../usecase/relay";
import { GoogleAccessTokenProvider, type ServiceAccount } from "./oauth";

/** FCM's hard limit on the total data payload size for a single message. */
const MAX_PAYLOAD_BYTES = 4096;

const FCM_ENDPOINT_BASE = "https://fcm.googleapis.com/v1/projects";

export interface FcmConfig {
  serviceAccount: ServiceAccount;
  dryRun: boolean;
}

interface AndroidConfig {
  priority: "high" | "normal";
  collapse_key?: string;
  ttl?: string;
}

export interface FcmMessage {
  token: string;
  data: Record<string, string>;
  android: AndroidConfig;
}

function androidPriorityFor(urgency: Message["urgency"]): "high" | "normal" {
  return urgency === "very-low" || urgency === "low" ? "normal" : "high";
}

function androidConfigFor(msg: Message): AndroidConfig {
  const config: AndroidConfig = { priority: androidPriorityFor(msg.urgency) };
  if (msg.topic !== "") config.collapse_key = msg.topic; // NOT truncated — unlike APNs, deliberately
  if (msg.ttl > 0) config.ttl = `${msg.ttl}s`;
  return config;
}

function dataSizeBytes(data: Record<string, string>): number {
  return new TextEncoder().encode(JSON.stringify(data)).byteLength;
}

/**
 * Builds the FCM data-only message. Size-checks ONLY the `data` object (not
 * the whole message) against the 4096-byte limit — this asymmetry with
 * APNs (which checks the whole payload) matches the Go implementation
 * exactly. Falls back to a body-less `data` (keeping just "e") when the
 * full data object is too large; throws PayloadTooLargeError (no network
 * call) if even that doesn't fit (practically unreachable).
 */
export function buildMessage(registrationToken: string, msg: Message): FcmMessage {
  let data: Record<string, string> = {
    p: base64UrlEncode(msg.body),
    e: "aes128gcm",
  };
  if (dataSizeBytes(data) > MAX_PAYLOAD_BYTES) {
    data = { e: "aes128gcm" };
    if (dataSizeBytes(data) > MAX_PAYLOAD_BYTES) {
      throw new PayloadTooLargeError();
    }
  }

  return {
    token: registrationToken,
    data,
    android: androidConfigFor(msg),
  };
}

interface FcmErrorDetail {
  ["@type"]?: string;
  errorCode?: string;
}

interface FcmErrorBody {
  error?: {
    details?: FcmErrorDetail[];
    status?: string;
    message?: string;
  };
}

const FCM_ERROR_DETAIL_TYPE = "type.googleapis.com/google.firebase.fcm.v1.FcmError";

export class FcmSenderImpl implements FcmSender {
  private readonly tokenProvider: GoogleAccessTokenProvider;

  constructor(private readonly config: FcmConfig) {
    this.tokenProvider = new GoogleAccessTokenProvider(config.serviceAccount);
  }

  async send(registrationToken: string, msg: Message, signal: AbortSignal): Promise<void> {
    const message = buildMessage(registrationToken, msg);
    const accessToken = await this.tokenProvider.getAccessToken(signal);

    const url = `${FCM_ENDPOINT_BASE}/${this.config.serviceAccount.project_id}/messages:send`;
    const body = this.config.dryRun ? { validate_only: true, message } : { message };

    let response: Response;
    try {
      response = await fetch(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
        signal,
      });
    } catch (err) {
      throw UpstreamError.wrap(err);
    }

    if (response.ok) return;

    // Only the FcmError detail's errorCode counts here (matching the Go
    // SDK's `messagingErrorCode` extraction) — the generic top-level
    // `error.status` RPC code is a different, broader classification and is
    // deliberately NOT consulted, to mirror Go's behavior exactly.
    let errorCode = "";
    try {
      const parsed = (await response.json()) as FcmErrorBody;
      const detail = parsed.error?.details?.find((d) => d["@type"] === FCM_ERROR_DETAIL_TYPE);
      errorCode = detail?.errorCode ?? "";
    } catch {
      // unparseable body; fall through with an empty errorCode
    }

    if (errorCode === "UNREGISTERED" || errorCode === "INVALID_ARGUMENT") {
      throw new UnregisteredError();
    }
    throw UpstreamError.withDetail(`fcm status=${response.status} errorCode=${errorCode}`);
  }
}
