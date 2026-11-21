import { useEffect, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { api, ApiError, type BatchDetail } from "../api";
import { useSession } from "../session";
import { ROLE_LABEL, StatusPill, Timeline, ago, fmt } from "../ui";

interface RowError { row: number; column: string; message: string }

export function BatchDetailPage() {
  const { id } = useParams();
  const { me, tick, toast } = useSession();
  const [batch, setBatch] = useState<BatchDetail | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [busy, setBusy] = useState(false);
  const [reason, setReason] = useState("");
  const [uploadErrors, setUploadErrors] = useState<{ message: string; errors: RowError[] } | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const load = () =>
    api.get<BatchDetail>(`/api/batches/${id}`).then(
      (b) => (setBatch(b), setNotFound(false)),
      (e) => e instanceof ApiError && e.status === 404 && setNotFound(true),
    );
  useEffect(() => void load(), [id, tick, me?.id]);

  async function run(fn: () => Promise<unknown>, success: string) {
    setBusy(true);
    try {
      await fn();
      toast(success);
      setReason("");
      await load();
    } catch (e) {
      toast(e instanceof ApiError ? e.message : "Something went wrong", "error");
    } finally {
      setBusy(false);
    }
  }

  async function upload() {
    const file = fileRef.current?.files?.[0];
    if (!file) return toast("Choose a .csv or .xlsx file first", "warn");
    setBusy(true);
    setUploadErrors(null);
    const fd = new FormData();
    fd.append("file", file);
    try {
      const r = await api.put<{ count: number }>(`/api/batches/${id}/candidates`, fd);
      toast(`${r.count} candidates uploaded`);
      if (fileRef.current) fileRef.current.value = "";
      await load();
    } catch (e) {
      if (e instanceof ApiError && e.status === 422) setUploadErrors({ message: e.message, errors: e.details?.errors ?? [] });
      else toast(e instanceof ApiError ? e.message : "Upload failed", "error");
    } finally {
      setBusy(false);
    }
  }

  if (notFound) return <div className="page"><div className="empty">This batch doesn't exist or you don't have access to it. <Link to="/batches">Back to batches</Link></div></div>;
  if (!batch) return <div className="page"><p className="muted">Loading…</p></div>;

  const isOwnCentre = me?.role === "CENTRE";
  const editable = isOwnCentre && (batch.status === "DRAFT" || batch.status === "SENT_BACK");
  const currentVotes = batch.decisions.filter((d) => d.counts && d.stage === batch.stage?.stage);
  const oldVotes = batch.decisions.filter((d) => !d.counts);

  return (
    <div className="page">
      <Link to="/batches" className="back">← Batches</Link>
      <header className="page-head">
        <div>
          <h1>{batch.title}</h1>
          <p className="muted">{batch.courseName} ({batch.courseCode}) · {batch.centre.name}, {batch.centre.district}</p>
        </div>
        <div className="head-status">
          <StatusPill status={batch.status} />
          {batch.escalatedAt && <span className="pill pill-escalated">Overdue since {fmt(batch.escalatedAt)}</span>}
          <span className="muted small">Round {batch.round || "–"} · at this stage {ago(batch.stageEnteredAt)}</span>
        </div>
      </header>

      {batch.status === "SENT_BACK" && batch.lastReason && (
        <div className="banner warn"><b>Sent back for changes:</b> {batch.lastReason}{isOwnCentre && " Fix the list, upload it again and resubmit. Earlier approvals will not carry over."}</div>
      )}
      {batch.status === "REJECTED" && batch.lastReason && <div className="banner error"><b>Rejected:</b> {batch.lastReason}</div>}
      {batch.dissent.length > 0 && me?.role !== "CENTRE" && (
        <div className="banner warn" role="note">
          <b>Not unanimous.</b> This batch moved on with {batch.dissent.length === 1 ? "a rejection" : `${batch.dissent.length} rejections`} outvoted:
          <ul className="dissent-list">
            {batch.dissent.map((d, i) => (
              <li key={i}><b>{d.actor}</b> rejected it at the {d.stage.toLowerCase()} stage{d.reason ? <>: “{d.reason}”</> : null}</li>
            ))}
          </ul>
          Check this before you decide.
        </div>
      )}

      {editable && (
        <section className="card action">
          <h2>Candidates file</h2>
          <p className="muted">Columns: <code>enrolment_no, name, phone, date_of_birth, score</code>. CSV or Excel, up to 1000 rows. If any row has a problem, nothing is saved and every problem is listed.</p>
          <div className="upload-row">
            <input ref={fileRef} id="file" type="file" accept=".csv,.xlsx" />
            <button className="btn" disabled={busy} onClick={() => void upload()}>Upload</button>
            <button className="btn primary" disabled={busy || batch.candidates.length === 0} onClick={() => void run(() => api.post(`/api/batches/${id}/submit`), "Submitted for district review")}>
              {batch.status === "SENT_BACK" ? "Resubmit for approval" : "Submit for approval"}
            </button>
          </div>
          {uploadErrors && (
            <div className="upload-errors" role="alert">
              <p><b>{uploadErrors.message}</b></p>
              <table>
                <thead><tr><th className="num">Row</th><th>Column</th><th>Problem</th></tr></thead>
                <tbody>{uploadErrors.errors.map((e, i) => <tr key={i}><td className="num">{e.row}</td><td><code>{e.column}</code></td><td>{e.message}</td></tr>)}</tbody>
              </table>
            </div>
          )}
        </section>
      )}

      {batch.stage && (
        <section className="card action">
          <h2>{ROLE_LABEL[batch.stage.ownerRole]} decision</h2>
          <p className="muted">
            Needs {batch.stage.quorum.APPROVE} approval{batch.stage.quorum.APPROVE > 1 ? "s from different officers" : ""} to move on.
            {" "}So far: {currentVotes.length === 0 ? "no votes" : currentVotes.map((v) => `${v.actor} (${v.action.toLowerCase().replace("_", " ")})`).join(", ")}.
          </p>
          {batch.awaitingMe ? (
            <div className="decide">
              <textarea id="reason" placeholder="Reason (required to reject or send back)" value={reason} onChange={(e) => setReason(e.target.value)} rows={2} />
              <div className="decide-buttons">
                <button className="btn primary" disabled={busy} onClick={() => void run(() => api.post(`/api/batches/${id}/decisions`, { action: "APPROVE" }), "Approval recorded")}>Approve</button>
                <button className="btn" disabled={busy || !reason.trim()} onClick={() => void run(() => api.post(`/api/batches/${id}/decisions`, { action: "SEND_BACK", reason }), "Sent back to the centre")}>Send back</button>
                <button className="btn danger" disabled={busy || !reason.trim()} onClick={() => void run(() => api.post(`/api/batches/${id}/decisions`, { action: "REJECT", reason }), "Rejection recorded")}>Reject</button>
              </div>
            </div>
          ) : (
            <p className="muted small">{me && me.role === batch.stage.ownerRole ? "You have already recorded your decision at this stage." : `Waiting for the ${ROLE_LABEL[batch.stage.ownerRole].toLowerCase()}.`}</p>
          )}
        </section>
      )}

      <div className="grid-2">
        <section className="card">
          <h2>Candidates <span className="muted">({batch.candidates.length})</span></h2>
          {batch.candidates.length === 0 ? (
            <p className="muted">No candidates uploaded yet.</p>
          ) : (
            <div className="table-wrap tight">
              <table>
                <thead><tr><th className="num">Row</th><th>Enrolment</th><th>Name</th><th>Phone</th><th className="num">Score</th><th>Certificate</th></tr></thead>
                <tbody>
                  {batch.candidates.map((c) => (
                    <tr key={c.id}>
                      <td className="num muted">{c.rowNumber}</td>
                      <td><code>{c.enrolmentNo}</code></td>
                      <td>{c.name}</td>
                      <td className="muted">{c.phone}</td>
                      <td className="num">{c.score}</td>
                      <td>{c.certificate ? <span className="small">{c.certificate.number} <StatusPill status={c.certificate.status === "REVOKED" ? "REVOKED" : c.certificate.deliveryStatus} /></span> : <span className="muted">–</span>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>

        <section className="card">
          <h2>Decisions</h2>
          {batch.decisions.length === 0 ? <p className="muted">No decisions yet.</p> : (
            <ul className="decisions">
              {batch.decisions.map((d) => (
                <li key={d.id} className={d.counts ? "" : "void"}>
                  <b>{d.actor}</b> <span className="muted">({ROLE_LABEL[d.actorRole]})</span> · {d.action.replace("_", " ").toLowerCase()} at {d.stage.toLowerCase()} stage · round {d.round}
                  {d.reason && <div className="muted small">“{d.reason}”</div>}
                  <div className="muted small">{fmt(d.createdAt)}{!d.counts && " · from an earlier round, no longer counted"}</div>
                </li>
              ))}
            </ul>
          )}
          {oldVotes.length > 0 && <p className="muted small">Votes from earlier rounds stay on record but do not count after a resubmission.</p>}
          <h2 className="mt">Full history</h2>
          <Timeline url={`/api/batches/${id}/timeline`} />
        </section>
      </div>
    </div>
  );
}
