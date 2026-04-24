import type { IMessagePayload } from "../types.js";

export function parseNotificationPayload(raw: unknown): IMessagePayload | null {
  if (!raw || typeof raw !== "object") return null;
  const wrapper = raw as Record<string, unknown>;
  const msg = (wrapper.message ?? wrapper) as Record<string, unknown>;
  if (!msg || typeof msg !== "object") return null;
  if (typeof msg.sender !== "string" && typeof msg.text !== "string") {
    return null;
  }
  return msg as unknown as IMessagePayload;
}
