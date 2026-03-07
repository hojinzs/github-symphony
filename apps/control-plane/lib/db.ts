import { PrismaClient } from "@prisma/client";

declare global {
  var __githubSymphonyPrisma__: PrismaClient | undefined;
}

export const db =
  globalThis.__githubSymphonyPrisma__ ??
  new PrismaClient({
    log: process.env.NODE_ENV === "development" ? ["warn", "error"] : ["error"]
  });

if (process.env.NODE_ENV !== "production") {
  globalThis.__githubSymphonyPrisma__ = db;
}
