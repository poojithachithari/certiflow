// Session + live-update context shared by every page.
import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { api, ApiError, type Me } from "./api";

interface Toast { id: number; text: string; tone: "ok" | "warn" | "error" }

interface SessionValue {
  me: Me | null;
  loading: boolean;
  switchUser: (userId: string) => Promise<void>;
  signOut: () => Promise<void>;
  /** Increments on every live change event; pages put it in their effect deps to refetch. */
  tick: number;
  connected: boolean;
  toast: (text: string, tone?: Toast["tone"]) => void;
  toasts: Toast[];
}

const Ctx = createContext<SessionValue>(null as unknown as SessionValue);
export const useSession = () => useContext(Ctx);

const EVENT_TEXT: Record<string, string> = {
  "batch.submitted": "A batch was submitted for review",
  "batch.status_changed": "A batch moved to a new stage",
  "batch.escalated": "A batch has waited too long and was escalated",
  "batch.issued": "Certificates were issued for a batch",
  "certificate.revoked": "A certificate was cancelled",
  "certificate.delivery_failed": "A WhatsApp delivery failed after all retries",
};

export function SessionProvider({ children }: { children: ReactNode }) {
  const [me, setMe] = useState<Me | null>(null);
  const [loading, setLoading] = useState(true);
  const [tick, setTick] = useState(0);
  const [connected, setConnected] = useState(false);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const nextId = useRef(1);

  const toast = useCallback((text: string, tone: Toast["tone"] = "ok") => {
    const id = nextId.current++;
    setToasts((t) => [...t, { id, text, tone }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 4500);
  }, []);

  const loadMe = useCallback(async () => {
    try {
      setMe(await api.get<Me>("/api/me"));
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) setMe(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => void loadMe(), [loadMe]);

  // One SSE stream per signed-in user. EventSource reconnects by itself after network blips
  // or an API restart; on reconnect we bump tick so pages catch up on anything missed.
  useEffect(() => {
    if (!me) return;
    const es = new EventSource("/api/events");
    es.addEventListener("ready", () => {
      setConnected(true);
      setTick((t) => t + 1);
    });
    es.addEventListener("change", (ev) => {
      setTick((t) => t + 1);
      try {
        const msg = JSON.parse((ev as MessageEvent).data);
        const text = EVENT_TEXT[msg.type];
        if (text && (msg.type !== "batch.escalated" || me.role === "STATE_OFFICE")) toast(text, msg.type.includes("fail") || msg.type.includes("escalated") ? "warn" : "ok");
      } catch {
        /* ignore malformed */
      }
    });
    es.onerror = () => setConnected(false);
    return () => es.close();
  }, [me, toast]);

  const switchUser = useCallback(async (userId: string) => {
    await api.post("/api/auth/demo-login", { userId });
    await loadMe();
  }, [loadMe]);

  const signOut = useCallback(async () => {
    await api.post("/api/auth/logout");
    setMe(null);
  }, []);

  return <Ctx.Provider value={{ me, loading, switchUser, signOut, tick, connected, toast, toasts }}>{children}</Ctx.Provider>;
}
