// Stand-in WhatsApp provider. Behaves like a real one, including the bad parts:
//  - random 500 / 429 errors                         (MOCK_FAILURE_RATE)
//  - timeouts where the message WAS delivered but the response never comes back in time
//    (MOCK_TIMEOUT_RATE) - the case that causes duplicate messages if the client isn't careful
//  - honours Idempotency-Key: a repeated key returns the original message, never sends twice
// GET /v1/messages?to=... is the "phone inbox" the demo UI shows.
// POST /admin/config lets reviewers simulate a full outage ({ "failureRate": 1 }).
import express from "express";
import { randomUUID } from "node:crypto";

interface Message {
  id: string;
  to: string;
  text: string;
  documentUrl: string;
  idempotencyKey: string;
  receivedAt: string;
}

export function createMockWhatsApp(initial = { failureRate: Number(process.env.MOCK_FAILURE_RATE ?? 0.2), timeoutRate: Number(process.env.MOCK_TIMEOUT_RATE ?? 0.1), timeoutDelayMs: Number(process.env.MOCK_TIMEOUT_DELAY_MS ?? 8000) }) {
  const settings = { ...initial };
  const byKey = new Map<string, Message>();
  const messages: Message[] = [];
  const stats = { requests: 0, failures: 0, timeouts: 0, deduplicated: 0, delivered: 0 };

  const app = express();
  app.use(express.json());

  app.post("/v1/messages", async (req, res) => {
    stats.requests++;
    const key = req.header("Idempotency-Key");
    const { to, text, documentUrl } = req.body ?? {};
    if (!key || typeof to !== "string" || !/^\+\d{10,15}$/.test(to)) return res.status(400).json({ error: "invalid request" });

    const existing = byKey.get(key);
    if (existing) {
      stats.deduplicated++;
      return res.json({ id: existing.id, deduplicated: true });
    }

    const roll = Math.random();
    if (roll < settings.failureRate) {
      stats.failures++;
      return res.status(Math.random() < 0.5 ? 500 : 429).json({ error: "temporary failure" });
    }

    const message: Message = { id: `wamid.${randomUUID()}`, to, text, documentUrl, idempotencyKey: key, receivedAt: new Date().toISOString() };
    byKey.set(key, message);
    messages.push(message);
    stats.delivered++;

    if (roll < settings.failureRate + settings.timeoutRate) {
      stats.timeouts++;
      await new Promise((r) => setTimeout(r, settings.timeoutDelayMs)); // delivered, but the client gives up waiting
    }
    res.json({ id: message.id });
  });

  app.get("/v1/messages", (req, res) => {
    const to = typeof req.query.to === "string" ? req.query.to : undefined;
    res.json(to ? messages.filter((m) => m.to === to) : messages.slice(-200).reverse());
  });
  app.get("/admin/stats", (_req, res) => res.json({ ...stats, settings }));
  app.post("/admin/config", (req, res) => {
    for (const k of ["failureRate", "timeoutRate", "timeoutDelayMs"] as const) if (typeof req.body?.[k] === "number") settings[k] = req.body[k];
    res.json(settings);
  });
  app.get("/health", (_req, res) => res.json({ ok: true }));

  return { app, messages, stats, settings };
}

if (require.main === module) {
  const port = Number(process.env.PORT ?? 4000);
  createMockWhatsApp().app.listen(port, () => console.log(JSON.stringify({ msg: "mock whatsapp listening", port })));
}
