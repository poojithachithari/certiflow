// Fixed-window rate limiter in Redis, shared by all API instances (an in-memory limiter
// would give each instance its own budget). Used on the public, no-login endpoints.
import type { NextFunction, Request, Response } from "express";
import type { Redis } from "ioredis";
import { HttpError } from "./errors";

export function rateLimit(redis: Redis, opts: { name: string; limit: number; windowSeconds: number }) {
  return async (req: Request, res: Response, next: NextFunction) => {
    const window = Math.floor(Date.now() / 1000 / opts.windowSeconds);
    const key = `ratelimit:${opts.name}:${req.ip}:${window}`;
    try {
      const count = await redis.incr(key);
      if (count === 1) await redis.expire(key, opts.windowSeconds);
      res.setHeader("RateLimit-Remaining", String(Math.max(opts.limit - count, 0)));
      if (count > opts.limit) return next(new HttpError(429, "RATE_LIMITED", "Too many checks. Please wait a minute and try again."));
    } catch {
      // Redis down: fail OPEN for verification (availability matters more than the limit here).
    }
    next();
  };
}
