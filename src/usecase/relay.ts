/**
 * ≙ webpush-relay/internal/usecase/relay.go
 *
 * Core types and the error taxonomy the whole relay is built on. Every wire
 * string a client can observe is defined once, here, so the handler's
 * response mapping and this file are the single source of truth for parity
 * with the Go implementation.
 */

export type Environment = "production" | "sandbox";

export type Urgency = "very-low" | "low" | "normal" | "high";

/** The still-encrypted WebPush payload plus the headers needed to forward it. */
export interface Message {
  body: Uint8Array;
  /** seconds; 0 means "not specified" (mirrors Go's zero-value-as-unset). */
  ttl: number;
  urgency: Urgency;
  topic: string;
}

export const MSG_UNREGISTERED = "device token is no longer registered";
export const MSG_PAYLOAD_TOO_LARGE = "payload too large for provider";
export const MSG_NOT_CONFIGURED = "provider not configured";
export const MSG_UPSTREAM = "upstream provider error";
export const MSG_DEADLINE_EXCEEDED = "context deadline exceeded";

/** Provider reports the device/registration token is no longer valid → 410. */
export class UnregisteredError extends Error {
  constructor() {
    super(MSG_UNREGISTERED);
    this.name = "UnregisteredError";
  }
}

/** Payload still exceeds the provider's size limit even after the fallback → 413. */
export class PayloadTooLargeError extends Error {
  constructor() {
    super(MSG_PAYLOAD_TOO_LARGE);
    this.name = "PayloadTooLargeError";
  }
}

/** The relay wasn't configured with credentials for the requested provider → 503. */
export class NotConfiguredError extends Error {
  constructor() {
    super(MSG_NOT_CONFIGURED);
    this.name = "NotConfiguredError";
  }
}

/** The 10-second upstream deadline elapsed → 504. */
export class DeadlineExceededError extends Error {
  constructor() {
    super(MSG_DEADLINE_EXCEEDED);
    this.name = "DeadlineExceededError";
  }
}

/**
 * Wraps an unexpected provider error (i.e. not a registration failure) → 502.
 * `detail` becomes the response body's error message verbatim.
 */
export class UpstreamError extends Error {
  constructor(detail: string) {
    super(detail);
    this.name = "UpstreamError";
  }

  /** ≙ errors.Join(usecase.ErrUpstream, err) — network/transport-level failure. */
  static wrap(cause: unknown): UpstreamError {
    const causeMessage = cause instanceof Error ? cause.message : String(cause);
    return new UpstreamError(`${MSG_UPSTREAM}\n${causeMessage}`);
  }

  /** ≙ fmt.Errorf("%w: %s", ErrUpstream, detail) — a classified provider rejection. */
  static withDetail(detail: string): UpstreamError {
    return new UpstreamError(`${MSG_UPSTREAM}: ${detail}`);
  }
}

export interface ApnsSender {
  send(env: Environment, deviceToken: string, msg: Message, signal: AbortSignal): Promise<void>;
}

export interface FcmSender {
  send(registrationToken: string, msg: Message, signal: AbortSignal): Promise<void>;
}

/**
 * The seam between the HTTP layer and the concrete provider clients. Either
 * sender may be null if the relay wasn't configured for that provider.
 */
export class RelayUsecase {
  constructor(
    private readonly apns: ApnsSender | null,
    private readonly fcm: FcmSender | null,
  ) {}

  async relayApns(
    env: Environment,
    deviceToken: string,
    msg: Message,
    signal: AbortSignal,
  ): Promise<void> {
    if (this.apns === null) throw new NotConfiguredError();
    await this.apns.send(env, deviceToken, msg, signal);
  }

  async relayFcm(registrationToken: string, msg: Message, signal: AbortSignal): Promise<void> {
    if (this.fcm === null) throw new NotConfiguredError();
    await this.fcm.send(registrationToken, msg, signal);
  }
}
