import { readFileSync } from 'node:fs';
import { z } from 'zod';

/**
 * The API's version, read from package.json so it's written down in one place
 * (CONTRIBUTING.md, "Releasing", says when to change it). The OpenAPI
 * document shows it.
 *
 * The path works from both src/config (tests, `npm run dev`) and dist/config
 * (the Docker image, which copies package.json next to dist/).
 */
const PackageJson = z.object({ version: z.string().regex(/^\d+\.\d+\.\d+$/) });

export const API_VERSION = PackageJson.parse(
  JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')),
).version;
