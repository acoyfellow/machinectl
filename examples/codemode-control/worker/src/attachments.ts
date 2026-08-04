export interface Attachment {
  id: string;
  mediaType: string;
  byteLength: number;
  dataUrl: string;
}

export interface AttachmentMetadata {
  attachmentId: string;
  mediaType: string;
  byteLength: number;
}

const ITEM_LIMIT = 8;
const AGGREGATE_BYTE_LIMIT = 24 * 1024 * 1024;
const DATA_URL_RE = /^data:(image\/(?:png|jpeg|webp|gif));base64,([A-Za-z0-9+/=\r\n]+)$/;

export function isImageDataUrl(value: string): boolean {
  return DATA_URL_RE.test(value);
}

export class AttachmentStore {
  private readonly items = new Map<string, Attachment>();
  private aggregateBytes = 0;

  get size(): number {
    return this.items.size;
  }

  retain(dataUrl: string): AttachmentMetadata | { error: string } {
    const match = DATA_URL_RE.exec(dataUrl);
    if (!match) return { error: "attachment is not a supported image data URL" };
    if (this.items.size >= ITEM_LIMIT) return { error: `attachment count limit of ${ITEM_LIMIT} reached for this execution` };
    const byteLength = new TextEncoder().encode(dataUrl).byteLength;
    if (this.aggregateBytes + byteLength > AGGREGATE_BYTE_LIMIT) return { error: "attachment aggregate byte limit reached for this execution" };
    const id = `att_${crypto.randomUUID().replaceAll("-", "")}`;
    this.items.set(id, { id, mediaType: match[1] ?? "image/png", byteLength, dataUrl });
    this.aggregateBytes += byteLength;
    return { attachmentId: id, mediaType: match[1] ?? "image/png", byteLength };
  }

  resolve(id: unknown): Attachment | undefined {
    return typeof id === "string" ? this.items.get(id) : undefined;
  }

  manifest(): readonly AttachmentMetadata[] {
    return [...this.items.values()].map((entry) => ({ attachmentId: entry.id, mediaType: entry.mediaType, byteLength: entry.byteLength }));
  }

  referenced(value: unknown): readonly Attachment[] {
    const found: Attachment[] = [];
    const seen = new Set<string>();
    const walk = (node: unknown, depth: number) => {
      if (depth > 8 || found.length >= ITEM_LIMIT) return;
      if (typeof node === "string") {
        const hit = this.items.get(node);
        if (hit && !seen.has(hit.id)) {
          seen.add(hit.id);
          found.push(hit);
        }
        return;
      }
      if (Array.isArray(node)) {
        for (const entry of node) walk(entry, depth + 1);
        return;
      }
      if (node && typeof node === "object") {
        for (const entry of Object.values(node as Record<string, unknown>)) walk(entry, depth + 1);
      }
    };
    walk(value, 0);
    return found;
  }
}
