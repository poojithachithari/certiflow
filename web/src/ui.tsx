// Small shared UI pieces.
import { useEffect, useState } from "react";
import { api, type BatchStatus, type DemoUser, type Role, type TimelineEntry } from "./api";
import { useSession } from "./session";

export const STATUS_LABEL: Record<BatchStatus, string> = {
  DRAFT: "Draft",
  DISTRICT_REVIEW: "District review",
  QUALITY_REVIEW: "Quality review",
  STATE_REVIEW: "State review",
  SENT_BACK: "Sent back",
  REJECTED: "Rejected",
  APPROVED: "Approved, issuing",
  ISSUED: "Certificates issued",
};

export const ROLE_LABEL: Record<Role, string> = {
  CENTRE: "Training centre",
  DISTRICT_OFFICER: "District officer",
  QUALITY: "Quality team",
  STATE_OFFICE: "State office",
};

export function StatusPill({ status }: { status: string }) {
  return <span className={`pill pill-${status.toLowerCase()}`}>{STATUS_LABEL[status as BatchStatus] ?? status.replace(/_/g, " ").toLowerCase()}</span>;
}

export function ago(iso: string): string {
  const mins = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} min`;
  const h = Math.floor(mins / 60);
  if (h < 48) return `${h} h ${mins % 60} min`;
  return `${Math.floor(h / 24)} days`;
}

export const fmt = (iso: string) => new Date(iso).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" });

export function PersonaBar() {
  const { me, switchUser, connected } = useSession();
  const [users, setUsers] = useState<DemoUser[]>([]);
  useEffect(() => void api.get<DemoUser[]>("/api/demo/users").then(setUsers).catch(() => undefined), []);
  const main = users.filter((u) => !["sunil", "ravi"].includes(u.id));
  const extra = users.filter((u) => ["sunil", "ravi"].includes(u.id));
  return (
    <div className="persona-bar" role="toolbar" aria-label="Switch demo user">
      <span className="persona-label">Acting as</span>
      <div className="persona-list">
        {[...main, ...extra].map((u) => (
          <button key={u.id} className={`persona ${me?.id === u.id ? "active" : ""} ${extra.includes(u) ? "extra" : ""}`} onClick={() => void switchUser(u.id)} title={`${ROLE_LABEL[u.role]}${u.district ? `, ${u.district}` : ""}${u.centre ? `, ${u.centre}` : ""}`}>
            <b>{u.name}</b>
            <small>{ROLE_LABEL[u.role]}{u.district ? ` · ${u.district}` : ""}</small>
          </button>
        ))}
      </div>
      {me && <span className={`live ${connected ? "on" : ""}`}>{connected ? "Live" : "Reconnecting"}</span>}
    </div>
  );
}

export function Toasts() {
  const { toasts } = useSession();
  return (
    <div className="toasts" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} className={`toast toast-${t.tone}`}>{t.text}</div>
      ))}
    </div>
  );
}

const ACTION_TEXT: Record<string, string> = {
  created: "Batch created",
  seeded: "Demo data loaded",
  candidates_uploaded: "Candidate list uploaded",
  submitted: "Submitted for review",
  "decision:APPROVE": "Approved",
  "decision:REJECT": "Rejected",
  "decision:SEND_BACK": "Sent back",
  escalated: "Escalated to state office (SLA breached)",
  issued: "Certificate issued",
  delivered: "Delivered on WhatsApp",
  delivery_attempt_failed: "WhatsApp attempt failed",
  delivery_failed: "Delivery failed after all retries",
  redelivery_requested: "Delivery retry requested",
  revoked: "Certificate cancelled",
};

export function Timeline({ url }: { url: string }) {
  const { tick } = useSession();
  const [rows, setRows] = useState<TimelineEntry[] | null>(null);
  useEffect(() => void api.get<TimelineEntry[]>(url).then(setRows).catch(() => setRows([])), [url, tick]);
  if (!rows) return <p className="muted">Loading history…</p>;
  return (
    <ol className="timeline">
      {rows.map((r) => {
        const text = r.action.startsWith("status:") ? `Status ${r.action.slice(7).replace("->", " → ")}` : ACTION_TEXT[r.action] ?? r.action;
        const detail = r.data?.reason ?? r.data?.error ?? (r.data?.number && r.entityType === "certificate" ? r.data.number : null) ?? (r.data?.count ? `${r.data.count} candidates` : null);
        return (
          <li key={r.id}>
            <time>{fmt(r.at)}</time>
            <span className="t-actor">{r.actor}</span>
            <span className="t-text">{text}{detail ? <em> · {String(detail)}</em> : null}</span>
            <code title="Correlation id: search the logs for this to trace the request end to end">{r.correlationId.slice(0, 8)}</code>
          </li>
        );
      })}
    </ol>
  );
}
