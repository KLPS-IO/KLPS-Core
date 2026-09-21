/** Safe provider-neutral failure. Never retain a raw provider body or request. */
export class SocialPublishError extends Error {
  readonly statusCode = 409;
  constructor(
    readonly code: string,
    message: string,
    readonly outcome: 'rejected' | 'unknown',
    readonly retryAfter: Date | null = null,
    readonly reauthorize = false,
    readonly providerHttpStatus: number | null = null
  ) { super(message); }
}
