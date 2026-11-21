import { Router } from "express";
import { z } from "zod";
import { COOKIE_NAME, requireUser, signSession } from "../auth";
import { prisma } from "../lib/prisma";
import { notFound } from "../lib/errors";

export const authRouter = Router();

// DEMO ONLY: the brief asks that reviewers can switch between people instantly.
// In production this is replaced by real sign-in (OTP / state SSO); see DEPLOYMENT.md.
authRouter.get("/demo/users", async (_req, res) => {
  const users = await prisma.user.findMany({
    include: { centre: true, district: true },
    orderBy: [{ role: "asc" }, { name: "asc" }],
  });
  res.json(users.map((u) => ({ id: u.id, name: u.name, role: u.role, district: u.district?.name ?? null, centre: u.centre?.name ?? null })));
});

authRouter.post("/auth/demo-login", async (req, res) => {
  const { userId } = z.object({ userId: z.string().min(1).max(50) }).parse(req.body);
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) throw notFound("No such demo user");
  res.cookie(COOKIE_NAME, signSession(user.id), { httpOnly: true, sameSite: "strict", secure: false, maxAge: 8 * 3600 * 1000, path: "/" });
  res.json({ id: user.id, name: user.name, role: user.role });
});

authRouter.post("/auth/logout", (_req, res) => {
  res.clearCookie(COOKIE_NAME, { path: "/" });
  res.status(204).end();
});

authRouter.get("/me", requireUser, async (req, res) => {
  const u = await prisma.user.findUniqueOrThrow({ where: { id: req.user!.id }, include: { centre: true, district: true } });
  res.json({ id: u.id, name: u.name, role: u.role, districtId: u.districtId, district: u.district?.name ?? null, centreId: u.centreId, centre: u.centre?.name ?? null });
});
