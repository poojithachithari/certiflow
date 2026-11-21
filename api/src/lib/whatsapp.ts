// WhatsApp provider adapter. Business code depends only on sendCertificateMessage();
// swapping the mock for Meta's Cloud API means changing this one file.
//
// Every send carries an Idempotency-Key (the certificate id). If a request times out AFTER the
// provider delivered it, our retry carries the same key and the provider returns the original
// message instead of sending a second one.
import { config } from "../config";

export class ProviderError extends Error {
  constructor(message: string, public retryable: boolean) {
    super(message);
  }
}

export interface OutgoingCertificateMessage {
  idempotencyKey: string;
  to: string;
  text: string;
  documentUrl: string;
}

const TIMEOUT_MS = Number(process.env.WHATSAPP_TIMEOUT_MS ?? 5000);

export async function sendCertificateMessage(msg: OutgoingCertificateMessage): Promise<{ messageId: string; deduplicated: boolean }> {
  let res: Response;
  try {
    res = await fetch(`${config.WHATSAPP_URL}/v1/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Idempotency-Key": msg.idempotencyKey },
      body: JSON.stringify({ to: msg.to, type: "document", text: msg.text, documentUrl: msg.documentUrl }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (e) {
    const err = e as Error;
    throw new ProviderError(err.name === "TimeoutError" ? `timed out after ${TIMEOUT_MS}ms` : `network error: ${err.message}`, true);
  }
  if (res.ok) {
    const body = (await res.json()) as { id: string; deduplicated?: boolean };
    return { messageId: body.id, deduplicated: !!body.deduplicated };
  }
  // 429 and 5xx are temporary; 4xx (bad number etc.) will never succeed, so don't retry.
  const retryable = res.status === 429 || res.status >= 500;
  throw new ProviderError(`provider returned ${res.status}`, retryable);
}
