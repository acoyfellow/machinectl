import { hasExpiredAccess } from "./auth.js";

export type SocketAttachment = { generation: string; connectedAt: number; expiresAt: number };

export function socketAttachmentExpired(attachment: SocketAttachment | null, now = Date.now()): boolean {
  return !attachment || !Number.isFinite(attachment.expiresAt) || hasExpiredAccess(attachment.expiresAt, now);
}

export type SocketStorageRead<T> = { expired: true } | { expired: false; value: T };

export async function readSocketStorageIfUnexpired<T>(
  attachment: SocketAttachment | null,
  read: () => Promise<T>,
  now: () => number = Date.now,
): Promise<SocketStorageRead<T>> {
  const value = await read();
  return socketAttachmentExpired(attachment, now()) ? { expired: true } : { expired: false, value };
}
