import { loadEnv } from './config/env.js';
import { LIMITS } from './config/limits.js';
import { buildApp } from './app.js';

const env = loadEnv();
const app = await buildApp(env);

/**
 * Graceful shutdown: when Docker/Kubernetes asks us to stop (SIGTERM),
 * stop accepting new requests, let in-flight ones finish, close the DB pool,
 * then exit. Without this, users can see dropped requests during deploys.
 *
 * Bounded (Power of Ten rule 2): if closing takes longer than
 * LIMITS.shutdownTimeoutMs, we exit anyway instead of hanging forever.
 */
async function shutdown(signal: NodeJS.Signals): Promise<void> {
  app.log.info({ signal }, 'shutting down');
  const forceExit = setTimeout(() => {
    app.log.error('graceful shutdown timed out, forcing exit');
    process.exit(1);
  }, LIMITS.shutdownTimeoutMs);
  forceExit.unref();

  try {
    await app.close();
    process.exit(0);
  } catch (err) {
    app.log.error({ err }, 'error during shutdown');
    process.exit(1);
  }
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  // `void` marks the promise as deliberately not awaited: shutdown() handles
  // its own errors, and a signal handler can't wait for anything anyway.
  process.once(signal, () => void shutdown(signal));
}

try {
  await app.listen({ port: env.PORT, host: env.HOST });
} catch (err) {
  app.log.error({ err }, 'failed to start');
  process.exit(1);
}
