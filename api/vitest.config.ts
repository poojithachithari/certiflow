import { defineConfig } from "vitest/config";

// Tests use a real Postgres + Redis (concurrency and constraint guarantees can't be proven with mocks).
// Defaults point at the docker-compose services exposed on localhost; inside the `test`
// container they are overridden by the compose environment.
export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    fileParallelism: false, // files share one test database
    testTimeout: 60_000,
    hookTimeout: 60_000,
    env: {
      DATABASE_URL: process.env.DATABASE_URL ?? "postgresql://certiflow:certiflow@localhost:5433/certiflow_test",
      REDIS_URL: process.env.REDIS_URL ?? "redis://localhost:6380",
      JWT_SECRET: "test-jwt-secret-0123456789",
      CERT_SIGNING_SECRET: "test-cert-secret-0123456789",
      WHATSAPP_URL: "http://127.0.0.1:4999",
      WHATSAPP_TIMEOUT_MS: "150",
      PUBLIC_BASE_URL: "http://localhost:8080",
      CERT_STORAGE_DIR: process.env.CERT_STORAGE_DIR ?? "./.certificates-test",
      LOG_LEVEL: "silent",
    },
  },
});
