/** ≙ webpush-relay/cmd/webpush-relay/main.go */
import { buildSenders } from "./infra/config/config";
import { handleRequest } from "./present/rest/handler";
import { RelayUsecase } from "./usecase/relay";

// Built lazily from the first request and memoized for the isolate's
// lifetime — env bindings are stable for that lifetime, and this avoids
// re-parsing secrets / re-importing crypto keys on every request.
let relay: RelayUsecase | undefined;

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (relay === undefined) {
      const senders = buildSenders(env);
      relay = new RelayUsecase(senders.apns, senders.fcm);
    }
    return handleRequest(request, relay);
  },
} satisfies ExportedHandler<Env>;
