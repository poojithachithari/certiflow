// Express app factory. Kept separate from server.ts so tests can build the app in-process.
import express, { type NextFunction, type Request, type Response } from "express";
import cookieParser from "cookie-parser";
import { randomUUID } from "node:crypto";
import multer from "multer";
import { ZodError } from "zod";
import { Prisma } from "@prisma/client";
import type { Redis } from "ioredis";
import { requireUser } from "./auth";
import { HttpError } from "./lib/errors";
import { logger } from "./lib/logger";
import { prisma } from "./lib/prisma";
import { addClient } from "./lib/realtime";
import { authRouter } from "./routes/auth";
import { batchesRouter } from "./routes/batches";
import { certificatesRouter, publicRouter } from "./routes/certificates";

export function createApp(redis: Redis) {
  const app = express();
  app.set("trust proxy", 1); // behind nginx: req.ip is the real client (used by rate limiting)
  app.disable("x-powered-by");
  app.use(express.json({ limit: "100kb" }));
  app.use(cookieParser());

  // Correlation id: accepted from upstream if well-formed, else generated. Flows into
  // audit rows and outbox events, so one action can be traced across api -> queue -> worker.
  app.use((req, res, next) => {
    const incoming = req.header("x-request-id");
    req.correlationId = incoming && /^[A-Za-z0-9-]{8,64}$/.test(incoming) ? incoming : randomUUID();
    res.setHeader("x-request-id", req.correlationId);
    const start = Date.now();
    res.on("finish", () => {
      if (req.path !== "/health") logger.info({ correlationId: req.correlationId, method: req.method, path: req.path, status: res.statusCode, ms: Date.now() - start, user: req.user?.id }, "request");
    });
    next();
  });

  app.get("/health", async (_req, res) => {
    await prisma.$queryRaw`SELECT 1`;
    res.json({ ok: true, redis: redis.status });
  });

  app.use("/api", authRouter);
  app.use("/api", publicRouter(redis));
  app.use("/api", batchesRouter);
  app.use("/api", certificatesRouter());

  // Server-Sent Events stream of changes the signed-in user may see.
  app.get("/api/events", requireUser, (req, res) => {
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive", "X-Accel-Buffering": "no" });
    res.write(`event: ready\ndata: {}\n\n`);
    const remove = addClient(req.user!, res);
    req.on("close", remove);
  });

  app.use("/api", (_req, _res, next) => next(new HttpError(404, "NOT_FOUND", "No such endpoint")));

  // One place that turns every error into a consistent JSON shape: { error: { code, message, details } }
  app.use((err: unknown, req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof HttpError) return res.status(err.status).json({ error: { code: err.code, message: err.message, details: err.details } });
    if (err instanceof ZodError) return res.status(400).json({ error: { code: "BAD_REQUEST", message: "Invalid input", details: err.issues.map((i) => ({ field: i.path.join("."), message: i.message })) } });
    if (err instanceof multer.MulterError) return res.status(400).json({ error: { code: "BAD_UPLOAD", message: err.code === "LIMIT_FILE_SIZE" ? "File is larger than 2 MB" : err.message } });
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      return res.status(409).json({ error: { code: "CONFLICT", message: "This would create a duplicate record" } });
    }
    if (err instanceof SyntaxError && "body" in err) return res.status(400).json({ error: { code: "BAD_REQUEST", message: "Malformed JSON" } });
    logger.error({ err, correlationId: req.correlationId }, "unhandled error");
    res.status(500).json({ error: { code: "INTERNAL", message: "Something went wrong. Reference: " + req.correlationId } });
  });

  return app;
}
