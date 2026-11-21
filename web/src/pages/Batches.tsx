import { useEffect, useState, type FormEvent } from "react";
import { Link, useNavigate } from "react-router-dom";
import { api, ApiError, type BatchSummary } from "../api";
import { useSession } from "../session";
import { StatusPill, ago } from "../ui";

export function BatchesPage() {
  const { me, tick, toast } = useSession();
  const navigate = useNavigate();
  const [batches, setBatches] = useState<BatchSummary[] | null>(null);
  const isReviewer = me?.role !== "CENTRE";
  const [tab, setTab] = useState<"mine" | "all">(isReviewer ? "mine" : "all");

  useEffect(() => void api.get<BatchSummary[]>("/api/batches").then(setBatches), [tick, me?.id]);
  useEffect(() => setTab(isReviewer ? "mine" : "all"), [isReviewer]);

  const [form, setForm] = useState({ title: "", courseCode: "", courseName: "" });
  const [creating, setCreating] = useState(false);
  async function create(e: FormEvent) {
    e.preventDefault();
    setCreating(true);
    try {
      const b = await api.post<{ id: string }>("/api/batches", form);
      toast("Batch created. Now upload its candidates.");
      navigate(`/batches/${b.id}`);
    } catch (err) {
      toast(err instanceof ApiError ? (err.details?.[0]?.message ?? err.message) : "Could not create batch", "error");
    } finally {
      setCreating(false);
    }
  }

  const shown = (batches ?? []).filter((b) => tab === "all" || b.awaitingMe);
  const waiting = (batches ?? []).filter((b) => b.awaitingMe).length;

  return (
    <div className="page">
      <header className="page-head">
        <div>
          <h1>{me?.role === "CENTRE" ? "Your batches" : "Batches"}</h1>
          <p className="muted">{me?.role === "CENTRE" ? me.centre : me?.role === "DISTRICT_OFFICER" ? `${me.district} district` : "All districts"}</p>
        </div>
        {isReviewer && (
          <div className="tabs" role="tablist">
            <button role="tab" aria-selected={tab === "mine"} className={tab === "mine" ? "on" : ""} onClick={() => setTab("mine")}>Waiting for me <span className="count">{waiting}</span></button>
            <button role="tab" aria-selected={tab === "all"} className={tab === "all" ? "on" : ""} onClick={() => setTab("all")}>All</button>
          </div>
        )}
      </header>

      {me?.role === "CENTRE" && (
        <form className="card create-form" onSubmit={create}>
          <h2>New batch</h2>
          <div className="form-row">
            <label>Batch title<input id="title" required minLength={3} value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} placeholder="AC technician batch 3" /></label>
            <label>Course code<input id="courseCode" required value={form.courseCode} onChange={(e) => setForm({ ...form, courseCode: e.target.value })} placeholder="ACT-L4" /></label>
            <label>Course name<input id="courseName" required minLength={3} value={form.courseName} onChange={(e) => setForm({ ...form, courseName: e.target.value })} placeholder="AC Technician (Level 4)" /></label>
            <button className="btn primary" disabled={creating}>{creating ? "Creating…" : "Create batch"}</button>
          </div>
        </form>
      )}

      {!batches ? (
        <p className="muted">Loading…</p>
      ) : shown.length === 0 ? (
        <div className="empty">{tab === "mine" ? "Nothing is waiting for you right now." : "No batches yet."}</div>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr><th>Batch</th><th>Centre</th><th>Status</th><th className="num">Candidates</th><th>Approvals</th><th>At this stage</th></tr>
            </thead>
            <tbody>
              {shown.map((b) => (
                <tr key={b.id} className={b.awaitingMe ? "row-attn" : ""}>
                  <td><Link to={`/batches/${b.id}`}><b>{b.title}</b></Link><div className="muted small">{b.courseName}{b.round > 1 ? ` · round ${b.round}` : ""}</div></td>
                  <td>{b.centre}<div className="muted small">{b.district}</div></td>
                  <td><StatusPill status={b.status} />{b.escalatedAt && <span className="pill pill-escalated">Overdue</span>}</td>
                  <td className="num">{b.candidates}</td>
                  <td>{b.approvalsNeeded ? `${b.approvals} of ${b.approvalsNeeded}` : "–"}</td>
                  <td className="muted">{ago(b.stageEnteredAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
