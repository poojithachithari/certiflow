// Live updates. The worker's outbox relay publishes every domain event on a Redis channel;
// EVERY API instance subscribes and forwards it over Server-Sent Events to the browsers
// connected to that instance - but only to users allowed to see that batch.
// Events carry only ids/status, never personal data: the browser re-fetches through the
// normal (authorised) endpoints.
import type { Response } from "express";
import type { User } from "@prisma/client";
import type { Redis } from "ioredis";
import { canSeeScope } from "../domain/access";
import { logger } from "./logger";

export const CHANNEL = "certiflow:changes";

export interface ChangeMessage {
  type: string;
  batchId: string;
  centreId: string;
  districtId: string;
  certificateId?: string;
  [k: string]: unknown;
}

const clients = new Set<{ user: User; res: Response }>();

export function addClient(user: User, res: Response) {
  const client = { user, res };
  clients.add(client);
  return () => clients.delete(client);
}

export function startRealtimeFanout(subscriber: Redis) {
  subscriber.subscribe(CHANNEL).catch((e) => logger.error({ err: e }, "realtime subscribe failed"));
  subscriber.on("message", (_channel, raw) => {
    let msg: ChangeMessage;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    for (const c of clients) {
      if (canSeeScope(c.user, msg)) c.res.write(`event: change\ndata: ${JSON.stringify(msg)}\n\n`);
    }
  });
  // Heartbeat keeps proxies from closing idle connections.
  setInterval(() => {
    for (const c of clients) c.res.write(`: ping\n\n`);
  }, 25_000).unref();
}
