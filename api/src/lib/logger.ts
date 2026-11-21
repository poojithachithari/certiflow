// Structured JSON logs. Every log line about a request/job carries a correlationId,
// so one batch's journey can be followed across api -> outbox -> queue -> worker.
import pino from "pino";
import { config } from "../config";

export const logger = pino({ level: config.LOG_LEVEL, base: { service: process.env.SERVICE_NAME ?? "api" } });
