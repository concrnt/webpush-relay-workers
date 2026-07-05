/** ≙ webpush-relay/internal/infra/config/config.go */
import { ApnsSenderImpl, type ApnsConfig } from "../apns/apns";
import { FcmSenderImpl, type FcmConfig } from "../fcm/fcm";
import type { ServiceAccount } from "../fcm/oauth";
import type { ApnsSender, FcmSender } from "../../usecase/relay";

// Merges the secret bindings (not declared in wrangler.jsonc, so absent from
// the generated worker-configuration.d.ts) onto the ambient global `Env`
// type alongside the vars `wrangler types` already generated.
declare global {
  interface Env {
    APNS_KEY?: string;
    APNS_KEY_ID?: string;
    APNS_TEAM_ID?: string;
    APNS_TOPIC?: string;
    FCM_SERVICE_ACCOUNT?: string;
  }
}

export interface RelaySenders {
  apns: ApnsSender | null;
  fcm: FcmSender | null;
}

/** ≙ APNs.Enabled() — all four fields must be present. */
function apnsConfigFrom(env: Env): ApnsConfig | null {
  const { APNS_KEY, APNS_KEY_ID, APNS_TEAM_ID, APNS_TOPIC } = env;
  if (!APNS_KEY || !APNS_KEY_ID || !APNS_TEAM_ID || !APNS_TOPIC) return null;
  return { keyPem: APNS_KEY, keyId: APNS_KEY_ID, teamId: APNS_TEAM_ID, topic: APNS_TOPIC };
}

/**
 * ≙ FCM.Enabled() — the service account JSON must be present and parse with
 * the fields the OAuth2 flow needs. Divergence from Go (documented): Go
 * fails at process startup on bad credentials; Workers has no startup, so a
 * present-but-malformed secret logs once and is treated as "not configured"
 * (503) rather than crashing.
 */
function fcmConfigFrom(env: Env): FcmConfig | null {
  if (!env.FCM_SERVICE_ACCOUNT) return null;
  let serviceAccount: ServiceAccount;
  try {
    serviceAccount = JSON.parse(env.FCM_SERVICE_ACCOUNT) as ServiceAccount;
  } catch (err) {
    console.error("FCM_SERVICE_ACCOUNT is not valid JSON", err);
    return null;
  }
  if (!serviceAccount.client_email || !serviceAccount.private_key || !serviceAccount.project_id) {
    console.error("FCM_SERVICE_ACCOUNT is missing client_email/private_key/project_id");
    return null;
  }
  // `wrangler types` infers a literal type from wrangler.jsonc's default
  // ("false"), but this var is freely overridable at deploy/dev time to any
  // string — widen it before comparing.
  const rawDryRun = env.FCM_DRY_RUN as string | undefined;
  const dryRun = rawDryRun?.toLowerCase() === "true" || rawDryRun === "1";
  return { serviceAccount, dryRun };
}

export function buildSenders(env: Env): RelaySenders {
  const apnsConfig = apnsConfigFrom(env);
  const fcmConfig = fcmConfigFrom(env);

  if (!apnsConfig) console.warn("apns not configured; /apns routes will return 503");
  if (!fcmConfig) console.warn("fcm not configured; /fcm routes will return 503");

  return {
    apns: apnsConfig ? new ApnsSenderImpl(apnsConfig) : null,
    fcm: fcmConfig ? new FcmSenderImpl(fcmConfig) : null,
  };
}
