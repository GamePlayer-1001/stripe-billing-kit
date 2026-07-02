export type BillingErrorCode =
  | 'config'
  | 'unauthorized'
  | 'invalid_plan'
  | 'no_customer'
  | 'webhook_verification'
  | 'not_found'
  | 'stripe';

const DEFAULT_STATUS: Record<BillingErrorCode, number> = {
  config: 500,
  unauthorized: 401,
  invalid_plan: 400,
  no_customer: 404,
  webhook_verification: 400,
  not_found: 404,
  stripe: 502,
};

export class BillingError extends Error {
  readonly code: BillingErrorCode;
  readonly status: number;

  constructor(code: BillingErrorCode, message: string, status?: number) {
    super(message);
    this.name = 'BillingError';
    this.code = code;
    this.status = status ?? DEFAULT_STATUS[code];
  }
}

export function isBillingError(err: unknown): err is BillingError {
  return err instanceof BillingError;
}
