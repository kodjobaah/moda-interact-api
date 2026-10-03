import { PrismaClient } from "@prisma/client";

export interface ReadinessDatabase {
  probe(): Promise<void>;
  disconnect(): Promise<void>;
}

export interface ApiDatabase extends ReadinessDatabase {
  prisma: PrismaClient;
}

export function createDatabase(databaseUrl: string): ApiDatabase {
  const prisma = new PrismaClient({
    datasources: {
      db: { url: databaseUrl },
    },
  });

  return {
    prisma,
    async probe() {
      await prisma.$queryRaw`SELECT 1`;
    },
    async disconnect() {
      await prisma.$disconnect();
    },
  };
}