/** ≙ webpush-relay/internal/present/rest/presenter/presenter.go */

function errorJson(status: number, message: string): Response {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** ≙ presenter.Created — 201 with an EMPTY body, not JSON. */
export function created(): Response {
  return new Response(null, { status: 201 });
}

export function badRequestMessage(message: string): Response {
  return errorJson(400, message);
}

export function unsupportedMediaType(message: string): Response {
  return errorJson(415, message);
}

export function serviceUnavailable(message: string): Response {
  return errorJson(503, message);
}

export function gone(message: string): Response {
  return errorJson(410, message);
}

export function payloadTooLarge(message: string): Response {
  return errorJson(413, message);
}

export function gatewayTimeout(message: string): Response {
  return errorJson(504, message);
}

export function badGateway(message: string): Response {
  return errorJson(502, message);
}

/** Not part of the documented relay contract (no route matched); kept simple and consistent with our own error shape. */
export function notFound(): Response {
  return errorJson(404, "Not Found");
}

/** Not part of the documented relay contract (wrong method on a known route). */
export function methodNotAllowed(): Response {
  return errorJson(405, "Method Not Allowed");
}
