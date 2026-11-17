import 'dotenv/config';
import { defineConfig } from 'prisma/config';

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: { path: 'prisma/migrations' },
  // Read directly (not with env()) so `prisma generate` also works in a
  // Docker build, where no database exists yet. Migrations still need it set.
  datasource: { url: process.env.DATABASE_URL ?? '' },
});
