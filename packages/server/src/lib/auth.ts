import { createHash, timingSafeEqual } from 'node:crypto';
import type { MiddlewareHandler } from 'hono';

/**
 * Hash a token string with SHA-256 so that timingSafeEqual always
 * compares buffers of equal length, regardless of input lengths.
 */
function sha256(value: string): Buffer {
  return createHash('sha256').update(value).digest();
}

/**
 * Call once at server startup to warn operators about weak tokens.
 */
export function validateTokenStrength(): void {
  const token = process.env['BUILDQ_TOKEN'];
  if (token !== undefined && token.length < 32) {
    console.warn(
      '[buildq] WARNING: BUILDQ_TOKEN is shorter than 32 characters. ' +
        'Use a longer token for production deployments.',
    );
  }
}

/**
 * Hono middleware that enforces Bearer-token authentication.
 *
 * - Skips the `/health` path so load-balancers can probe without a token.
 * - Compares the SHA-256 digest of the presented token against the digest of
 *   BUILDQ_TOKEN using `crypto.timingSafeEqual` to avoid timing side-channels.
 * - Returns a generic 401 on any auth failure (missing header, bad format,
 *   wrong token) without revealing which check failed.
 */
export const authMiddleware: MiddlewareHandler = async (c, next) => {
  // Allow health checks through without authentication.
  if (c.req.path === '/health') {
    return next();
  }

  const expectedToken = process.env['BUILDQ_TOKEN'];

  // If no token is configured the server is wide-open (dev mode).
  if (expectedToken === undefined || expectedToken === '') {
    return next();
  }

  const authHeader = c.req.header('Authorization');

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return c.json({ error: 'Unauthorized' }, 401);
  }

  const presentedToken = authHeader.slice('Bearer '.length);

  const expectedHash = sha256(expectedToken);
  const presentedHash = sha256(presentedToken);

  if (!timingSafeEqual(expectedHash, presentedHash)) {
    return c.json({ error: 'Unauthorized' }, 401);
  }

  return next();
};
