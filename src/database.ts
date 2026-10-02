import { PrismaClient } from "@prisma/client";

export interface ReadinessDatabase {
  probe(): Promise<void>;
  disconnect(): Promise<void>;
}

export function createDatabase(databaseUrl: string): ReadinessDatabase {
  const prisma = new PrismaClient({
    datasources: {
      db: { url: databaseUrl },
    },
  });

  return {
    async probe() {
      await prisma.$queryRaw`SELECT 1`;
    },
    async disconnect() {
      await prisma.$disconnect();
    },
  };
}