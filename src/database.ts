import { PrismaClient } from "@prisma/client";

export interface ReadinessDatabase {
  probe(): Promise<void>;
  disconnect(): Promise<void>;
}

export interface ApiDatabase extends ReadinessDatabase {
  prisma: PrismaClient;
}

export function createReadinessClient(databaseUrl: string): PrismaClient {
  const url = new URL(databaseUrl);
  for (const key of ["connection_limit", "pool_timeout", "connect_timeout", "socket_timeout"]) {
    url.searchParams.set(key, "1");
  }
  const existingOptions = url.searchParams.get("options")?.trim();
  const options = [existingOptions, "-c statement_timeout=500ms"].filter(Boolean).join(" ");
  url.searchParams.set("options", options);
  return new PrismaClient({ datasources: { db: { url: url.toString() } } });
}

export function createDatabase(databaseUrl: string): ApiDatabase {
  const prisma = new PrismaClient({
    datasources: {
      db: { url: databaseUrl },
    },
  });

  const readiness = createReadinessClient(databaseUrl);
  return {
    prisma,
    async probe() {
      await readiness.$queryRaw`SELECT 1`;
    },
    async disconnect() {
      const results = await Promise.allSettled([prisma.$disconnect(), readiness.$disconnect()]);
      const failures = results.flatMap(result => result.status === "rejected" ? [result.reason as unknown] : []);
      if (failures.length) throw new AggregateError(failures, "Database shutdown failed");
    },
  };
}
