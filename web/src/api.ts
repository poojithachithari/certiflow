// Thin fetch wrapper. The session cookie is httpOnly, so the browser sends it automatically;
// this code never sees or stores the token.

export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string, public details?: any) {
    super(message);
  }
}

async function request<T>(method: string, url: string, body?: unknown): Promise<T> {
  const init: RequestInit = { method, credentials: "same-origin", headers: {} };
  if (body instanceof FormData) init.body = body;
  else if (body !== undefined) {
    init.body = JSON.stringify(body);
    (init.headers as Record<string, string>)["Content-Type"] = "application/json";
  }
  const res = await fetch(url, init);
  if (res.status === 204) return undefined as T;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, data?.error?.code ?? "ERROR", data?.error?.message ?? `Request failed (${res.status})`, data?.error?.details);
  return data as T;
}

export const api = {
  get: <T>(url: string) => request<T>("GET", url),
  post: <T>(url: string, body?: unknown) => request<T>("POST", url, body ?? {}),
  put: <T>(url: string, body?: unknown) => request<T>("PUT", url, body),
};

export type Role = "CENTRE" | "DISTRICT_OFFICER" | "QUALITY" | "STATE_OFFICE";
export type BatchStatus = "DRAFT" | "DISTRICT_REVIEW" | "QUALITY_REVIEW" | "STATE_REVIEW" | "SENT_BACK" | "REJECTED" | "APPROVED" | "ISSUED";

export interface Me { id: string; name: string; role: Role; district: string | null; centre: string | null }
export interface DemoUser { id: string; name: string; role: Role; district: string | null; centre: string | null }

export interface BatchSummary {
  id: string; title: string; courseCode: string; courseName: string; status: BatchStatus; round: number;
  centre: string; district: string; candidates: number; certificates: number; stageEnteredAt: string;
  escalatedAt: string | null; lastReason: string | null; approvals: number; approvalsNeeded: number | null; awaitingMe: boolean; updatedAt: string;
}

export interface BatchDetail extends Omit<BatchSummary, "centre" | "district" | "candidates" | "certificates" | "approvals" | "approvalsNeeded"> {
  centre: { id: string; name: string; district: string };
  stage: { stage: string; ownerRole: Role; quorum: Record<string, number> } | null;
  candidates: { id: string; rowNumber: number; enrolmentNo: string; name: string; phone: string; dateOfBirth: string | null; score: number; certificate: { number: string; status: string; deliveryStatus: string } | null }[];
  decisions: { id: string; round: number; stage: string; action: string; reason: string | null; actor: string; actorRole: Role; createdAt: string; counts: boolean }[];
}

export interface Certificate {
  id: string; number: string; holderName: string; enrolmentNo: string; course: string; batch: string; batchId: string;
  status: "VALID" | "REVOKED"; issuedAt: string; revokedAt: string | null; revokeReason: string | null;
  deliveryStatus: "PENDING" | "SENT" | "FAILED"; deliveryAttempts: number; lastDeliveryError: string | null;
}

export interface TimelineEntry { id: string; at: string; entityType: string; entityId: string; action: string; actor: string; data: any; correlationId: string }
