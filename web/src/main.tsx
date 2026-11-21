import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, NavLink, Navigate, Route, Routes } from "react-router-dom";
import { SessionProvider, useSession } from "./session";
import { PersonaBar, Toasts } from "./ui";
import { BatchesPage } from "./pages/Batches";
import { BatchDetailPage } from "./pages/BatchDetail";
import { CertificatesPage, PhonePage, StuckPage, VerifyPage } from "./pages/Other";
import "./styles.css";

function Shell() {
  const { me, loading } = useSession();
  return (
    <>
      <header className="topbar">
        <div className="brand"><span className="mark">CF</span><div><b>CertiFlow</b><small>Pragati Skills Mission</small></div></div>
        <nav>
          {me && <NavLink to="/batches">Batches</NavLink>}
          {me?.role === "STATE_OFFICE" && <NavLink to="/stuck">In review</NavLink>}
          {me && <NavLink to="/certificates">Certificates</NavLink>}
          <NavLink to="/verify">Verify</NavLink>
          <NavLink to="/phone">Phones (demo)</NavLink>
        </nav>
      </header>
      <PersonaBar />
      <main>
        {loading ? <p className="page muted">Loading…</p> : (
          <Routes>
            <Route path="/verify" element={<VerifyPage />} />
            <Route path="/phone" element={<PhonePage />} />
            {me ? (
              <>
                <Route path="/batches" element={<BatchesPage />} />
                <Route path="/batches/:id" element={<BatchDetailPage />} />
                <Route path="/certificates" element={<CertificatesPage />} />
                {me.role === "STATE_OFFICE" && <Route path="/stuck" element={<StuckPage />} />}
                <Route path="*" element={<Navigate to="/batches" replace />} />
              </>
            ) : (
              <Route path="*" element={<div className="page narrow"><div className="empty"><h2>Pick a person above to start</h2><p>Anika runs a training centre, Dev, Meera and Kabir are Pune district officers, Neha is the quality team and Farah is the state office. Employers can use <b>Verify</b> without signing in.</p></div></div>} />
            )}
          </Routes>
        )}
      </main>
      <Toasts />
    </>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <BrowserRouter>
      <SessionProvider>
        <Shell />
      </SessionProvider>
    </BrowserRouter>
  </StrictMode>,
);
