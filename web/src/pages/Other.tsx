import { useEffect, useState, type FormEvent } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { api, ApiError, type Certificate } from "../api";
import { useSession } from "../session";
import { StatusPill, ago, fmt } from "../ui";

interface Stuck { id: string; title: string; status: string; centre: string; district: string; stageEnteredAt: string; escalatedAt: string | null; waitingMinutes: number }

export function StuckPage() {
  const { tick } = useSession();
  const [rows, setRows] = useState<Stuck[] | null>(null);
  useEffect(() => void api.get<Stuck[]>("/api/stuck").then(setRows), [tick]);
  return (
    <div className="page">
      <header className="page-head"><div><h1>Batches in review</h1><p className="muted">Oldest first. Batches past the time limit at one stage are flagged automatically.</p></div></header>
      {!rows ? <p className="muted">Loading…</p> : rows.length === 0 ? <div className="empty">No batches are waiting for review.</div> : (
        <div className="table-wrap">
          <table>
            <thead><tr><th>Batch</th><th>Waiting at</th><th>For</th><th>District</th><th>Escalation</th></tr></thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} className={r.escalatedAt ? "row-attn" : ""}>
                  <td><Link to={`/batches/${r.id}`}><b>{r.title}</b></Link><div className="muted small">{r.centre}</div></td>
                  <td><StatusPill status={r.status} /></td>
                  <td>{ago(r.stageEnteredAt)}</td>
                  <td>{r.district}</td>
                  <td>{r.escalatedAt ? <span className="pill pill-escalated">Escalated {fmt(r.escalatedAt)}</span> : <span className="muted">Within limit</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

export function CertificatesPage() {
  const { me, tick, toast } = useSession();
  const [rows, setRows] = useState<Certificate[] | null>(null);
  const [revoking, setRevoking] = useState<string | null>(null);
  const [reason, setReason] = useState("");
  const [filter, setFilter] = useState("");
  const load = () => api.get<Certificate[]>("/api/certificates").then(setRows);
  useEffect(() => void load(), [tick, me?.id]);
  const isState = me?.role === "STATE_OFFICE";

  async function act(fn: () => Promise<unknown>, ok: string) {
    try {
      await fn();
      toast(ok);
      setRevoking(null);
      setReason("");
      await load();
    } catch (e) {
      toast(e instanceof ApiError ? e.message : "Failed", "error");
    }
  }

  const shown = (rows ?? []).filter((c) => !filter || `${c.number} ${c.holderName} ${c.enrolmentNo} ${c.batch}`.toLowerCase().includes(filter.toLowerCase()));
  const stats = { sent: rows?.filter((c) => c.deliveryStatus === "SENT").length ?? 0, pending: rows?.filter((c) => c.deliveryStatus === "PENDING").length ?? 0, failed: rows?.filter((c) => c.deliveryStatus === "FAILED").length ?? 0 };

  return (
    <div className="page">
      <header className="page-head">
        <div><h1>Certificates</h1><p className="muted">{stats.sent} delivered · {stats.pending} sending · {stats.failed} failed</p></div>
        <input className="search" id="cert-search" placeholder="Search number, name, batch" value={filter} onChange={(e) => setFilter(e.target.value)} />
      </header>
      {!rows ? <p className="muted">Loading…</p> : shown.length === 0 ? <div className="empty">No certificates yet.</div> : (
        <div className="table-wrap">
          <table>
            <thead><tr><th>Number</th><th>Holder</th><th>Course</th><th>Status</th><th>WhatsApp</th>{isState && <th>Actions</th>}</tr></thead>
            <tbody>
              {shown.map((c) => (
                <tr key={c.id}>
                  <td><code>{c.number}</code><div className="muted small">{fmt(c.issuedAt)}</div></td>
                  <td>{c.holderName}<div className="muted small">{c.enrolmentNo}</div></td>
                  <td>{c.course}<div className="muted small"><Link to={`/batches/${c.batchId}`}>{c.batch}</Link></div></td>
                  <td><StatusPill status={c.status} />{c.revokeReason && <div className="muted small">“{c.revokeReason}”</div>}</td>
                  <td><StatusPill status={c.deliveryStatus} /><div className="muted small">{c.deliveryAttempts} attempt{c.deliveryAttempts === 1 ? "" : "s"}{c.lastDeliveryError && c.deliveryStatus !== "SENT" ? ` · ${c.lastDeliveryError}` : ""}</div></td>
                  {isState && (
                    <td>
                      {c.status === "VALID" && revoking !== c.id && <button className="btn small danger" onClick={() => setRevoking(c.id)}>Cancel certificate</button>}
                      {revoking === c.id && (
                        <form className="inline-form" onSubmit={(e: FormEvent) => { e.preventDefault(); void act(() => api.post(`/api/certificates/${c.id}/revoke`, { reason }), `${c.number} cancelled`); }}>
                          <input id={`reason-${c.id}`} autoFocus required minLength={3} placeholder="Reason" value={reason} onChange={(e) => setReason(e.target.value)} />
                          <button className="btn small danger">Confirm cancel</button>
                          <button type="button" className="btn small" onClick={() => setRevoking(null)}>Keep</button>
                        </form>
                      )}
                      {c.deliveryStatus === "FAILED" && c.status === "VALID" && <button className="btn small" onClick={() => void act(() => api.post(`/api/certificates/${c.id}/retry-delivery`), "Delivery retry queued")}>Retry WhatsApp</button>}
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

type VerifyResult = { result: "NOT_FOUND" } | { result: "VALID" | "REVOKED"; number: string; holder: string; course: string; centre: string; issuedAt: string; revokedAt: string | null; revokeReason: string | null };

export function VerifyPage() {
  const [params] = useSearchParams();
  const [number, setNumber] = useState(params.get("n") ?? "");
  const [code, setCode] = useState(params.get("c") ?? "");
  const [result, setResult] = useState<VerifyResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);

  async function check(n = number, c = code) {
    setChecking(true);
    setError(null);
    try {
      setResult(await api.get<VerifyResult>(`/api/public/verify?number=${encodeURIComponent(n)}&code=${encodeURIComponent(c)}`));
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Could not check right now");
    } finally {
      setChecking(false);
    }
  }
  useEffect(() => {
    if (params.get("n") && params.get("c")) void check(params.get("n")!, params.get("c")!);
  }, []);

  return (
    <div className="page narrow">
      <header className="page-head"><div><h1>Check a certificate</h1><p className="muted">Enter the certificate number and verification code printed on it, or scan its QR code. No login needed.</p></div></header>
      <form className="card verify-form" onSubmit={(e) => { e.preventDefault(); void check(); }}>
        <label>Certificate number<input id="v-number" required value={number} onChange={(e) => setNumber(e.target.value)} placeholder="PSM-2026-100023" /></label>
        <label>Verification code<input id="v-code" required value={code} onChange={(e) => setCode(e.target.value)} placeholder="7KQ2M-X9ATR" /></label>
        <button className="btn primary" disabled={checking}>{checking ? "Checking…" : "Check"}</button>
      </form>
      {error && <div className="banner error">{error}</div>}
      {result && (
        result.result === "NOT_FOUND" ? (
          <div className="verdict bad"><h2>Not found</h2><p>No certificate matches this number and code. Check both for typing mistakes. If they are correct, this certificate was not issued by the Pragati Skills Mission.</p></div>
        ) : result.result === "VALID" ? (
          <div className="verdict good"><h2>Genuine and valid</h2><dl><dt>Number</dt><dd>{result.number}</dd><dt>Holder</dt><dd>{result.holder}</dd><dt>Course</dt><dd>{result.course}</dd><dt>Centre</dt><dd>{result.centre}</dd><dt>Issued</dt><dd>{fmt(result.issuedAt)}</dd></dl><p className="muted small">The name is partly hidden to protect the holder's privacy. Compare it with the certificate in front of you.</p></div>
        ) : (
          <div className="verdict bad"><h2>Cancelled: not valid</h2><dl><dt>Number</dt><dd>{result.number}</dd><dt>Cancelled on</dt><dd>{result.revokedAt ? fmt(result.revokedAt) : "–"}</dd><dt>Reason</dt><dd>{result.revokeReason ?? "–"}</dd><dt>Course</dt><dd>{result.course}</dd></dl><p className="muted small">This certificate was issued but has since been cancelled by the state office. Do not accept it.</p></div>
        )
      )}
    </div>
  );
}

interface PhoneMessage { id: string; to: string; text: string; documentUrl: string; receivedAt: string }

/** Demo-only: the messages the stand-in WhatsApp provider "delivered" to candidates' phones. */
export function PhonePage() {
  const { tick, toast } = useSession();
  const [msgs, setMsgs] = useState<PhoneMessage[] | null>(null);
  const [stats, setStats] = useState<{ requests: number; failures: number; timeouts: number; deduplicated: number; delivered: number; settings: { failureRate: number } } | null>(null);
  const load = () => {
    void fetch("/mock-whatsapp/v1/messages").then((r) => r.json()).then(setMsgs).catch(() => setMsgs([]));
    void fetch("/mock-whatsapp/admin/stats").then((r) => r.json()).then(setStats).catch(() => undefined);
  };
  useEffect(load, [tick]);
  const outage = stats?.settings.failureRate === 1;
  async function setFailure(failureRate: number) {
    await fetch("/mock-whatsapp/admin/config", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ failureRate }) });
    toast(failureRate === 1 ? "WhatsApp outage simulated: every send now fails" : "WhatsApp restored (20% random failures)");
    load();
  }
  return (
    <div className="page">
      <header className="page-head">
        <div><h1>Candidate phones</h1><p className="muted">Demo view of the stand-in WhatsApp provider. It fails and times out on purpose; each candidate should still get exactly one message.</p></div>
        <button className={`btn ${outage ? "primary" : "danger"}`} onClick={() => void setFailure(outage ? 0.2 : 1)}>{outage ? "End outage" : "Simulate WhatsApp outage"}</button>
      </header>
      {stats && <p className="stats-line"><b>{stats.requests}</b> send attempts · <b>{stats.failures}</b> failed · <b>{stats.timeouts}</b> timed out after delivering · <b>{stats.deduplicated}</b> duplicates blocked · <b>{stats.delivered}</b> messages delivered</p>}
      {!msgs ? <p className="muted">Loading…</p> : msgs.length === 0 ? <div className="empty">No messages yet. Approve a batch as Farah to send certificates.</div> : (
        <div className="phones">
          {msgs.map((m) => (
            <article key={m.id} className="bubble">
              <header><b>{m.to}</b><time>{fmt(m.receivedAt)}</time></header>
              <p>{m.text.split(" . ")[0]}.</p>
              <a className="btn small primary" href={m.documentUrl} target="_blank" rel="noreferrer">Download certificate (PDF)</a>
            </article>
          ))}
        </div>
      )}
    </div>
  );
}
