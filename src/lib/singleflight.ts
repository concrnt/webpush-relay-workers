/**
 * Deduplicates concurrent async work within a single isolate: if `do()` is
 * called again while a previous call's promise is still in flight, the
 * caller gets that same promise instead of starting a second one. Used so
 * that N concurrent requests hitting a cold/expired token cache trigger only
 * one JWT signing (APNs) or one OAuth2 token exchange (FCM), not one per
 * request.
 */
export class Singleflight<T> {
  private inflight: Promise<T> | null = null;

  do(fn: () => Promise<T>): Promise<T> {
    if (this.inflight === null) {
      this.inflight = fn().finally(() => {
        this.inflight = null;
      });
    }
    return this.inflight;
  }
}
