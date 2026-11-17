import { loadEnv } from './config/env.js';
import { buildApp } from './app.js';

const env = loadEnv();
const app = await buildApp(env);

/**
 * Graceful shutdown: when Docker/Kubernetes asks us to stop (SIGTERM),
 * stop accepting new requests, let in-flight ones finish, close the DB pool,
 * then exit. Without this, users can see dropped requests during deploys.
 */
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, async () => {
    app.log.info({ signal }, 'shutting down');
    await app.close();
    process.exit(0);
  });
}

try {
  await app.listen({ port: env.PORT, host: env.HOST });
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
