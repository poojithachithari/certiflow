// Authentication: who is making this request?
//
// - The token is a JWT in an httpOnly, SameSite=Strict cookie: JS cannot read it (XSS can't steal it)
//   and other sites cannot make the browser send it (CSRF).
// - The token holds ONLY the user id. Role, district and centre are loaded from the DB on every
//   request, so permissions can never come from something the client controls.
// - jwt.verify is pinned to HS256 to block algorithm-confusion / "alg: none" forgeries.
import type { NextFunction, Request, Response } from "express";
import jwt from "jsonwebtoken";
import type { User } from "@prisma/client";
import { config } from "./config";
import { prisma } from "./lib/prisma";
import { forbidden, unauthorized } from "./lib/errors";

export const COOKIE_NAME = "certiflow_session";

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: User;
      correlationId: string;
    }
  }
}

export function signSession(userId: string): string {
  return jwt.sign({ sub: userId }, config.JWT_SECRET, { algorithm: "HS256", expiresIn: "8h" });
}

export async function userFromToken(token: string | undefined): Promise<User | null> {
  if (!token) return null;
  try {
    const payload = jwt.verify(token, config.JWT_SECRET, { algorithms: ["HS256"] });
    if (typeof payload !== "object" || typeof payload.sub !== "string") return null;
    return await prisma.user.findUnique({ where: { id: payload.sub } });
  } catch {
    return null; // bad signature, expired, malformed -> treated as not signed in
  }
}

function tokenFrom(req: Request): string | undefined {
  const header = req.headers.authorization;
  if (header?.startsWith("Bearer ")) return header.slice(7); // used by API tests / scripts
  return req.cookies?.[COOKIE_NAME];
}

export async function requireUser(req: Request, _res: Response, next: NextFunction) {
  const user = await userFromToken(tokenFrom(req));
  if (!user) return next(unauthorized());
  req.user = user;
  next();
}

export function requireRole(...roles: User["role"][]) {
  return (req: Request, _res: Response, next: NextFunction) => {
    if (!req.user || !roles.includes(req.user.role)) return next(forbidden());
    next();
  };
}
