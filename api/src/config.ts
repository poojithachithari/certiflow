// All configuration comes from environment variables (12-factor), validated at startup
// so a misconfigured container fails fast instead of misbehaving later.
import { z } from "zod";

const schema = z.object({
  DATABASE_URL: z.string().url(),
  REDIS_URL: z.string().default("redis://localhost:6379"),
  JWT_SECRET: z.string().min(16),
  CERT_SIGNING_SECRET: z.string().min(16),
  WHATSAPP_URL: z.string().url().default("http://localhost:4000"),
  PUBLIC_BASE_URL: z.string().url().default("http://localhost:8080"),
  CERT_STORAGE_DIR: z.string().default("./.certificates"),
  SLA_MINUTES: z.coerce.number().positive().default(2880),
  QUALITY_REVIEW_THRESHOLD: z.coerce.number().int().positive().default(50),
  DISTRICT_QUORUM: z.coerce.number().int().min(2).default(2),
  PORT: z.coerce.number().int().default(3000),
  LOG_LEVEL: z.string().default("info"),
});

export const config = schema.parse(process.env);
export type Config = typeof config;
