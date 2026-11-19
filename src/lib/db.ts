import type { Prisma, PrismaClient } from '../generated/prisma/client.js';

/** A database handle: the normal client, or the client inside a transaction. */
export type Db = PrismaClient | Prisma.TransactionClient;
