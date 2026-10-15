import crypto from 'node:crypto';

/**
 * Computes an HMAC SHA-256 signature for a webhook payload.
 * Format: sha256=<hex_digest>
 */
export function signPayload(payloadString: string, secret: string): string {
  const hmac = crypto.createHmac('sha256', secret);
  hmac.update(payloadString, 'utf8');
  return `sha256=${hmac.digest('hex')}`;
}

/**
 * Timing-safe signature verification helper.
 */
export function verifySignature(
  payloadString: string,
  secret: string,
  providedSignature: string
): boolean {
  const expected = signPayload(payloadString, secret);
  if (expected.length !== providedSignature.length) {
    return false;
  }
  return crypto.timingSafeEqual(
    Buffer.from(expected, 'utf8'),
    Buffer.from(providedSignature, 'utf8')
  );
}

/**
 * Generates a random secure secret if none provided.
 */
export function generateSecret(): string {
  return 'whsec_' + crypto.randomBytes(24).toString('hex');
}
