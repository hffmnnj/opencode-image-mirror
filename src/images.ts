import { createHash } from "node:crypto"

/**
 * Structural view of the LLM messages handed to a `session.context` hook. We
 * deliberately keep this narrow: the plugin only needs the image-bearing
 * shapes, and a structural type keeps the pure helpers easy to test without
 * constructing the full OpenCode message schemas.
 */
export interface RequestPart {
  readonly type?: string
  readonly text?: string
  readonly media?: {
    readonly source?: {
      readonly type?: string
      readonly data?: string | Uint8Array
      readonly url?: string
      readonly mediaType?: string
      readonly provider?: string
      readonly id?: string
    }
    readonly mediaType?: string
  }
  readonly filename?: string
  readonly result?: {
    readonly type?: string
    readonly value?: unknown
  }
}

export interface RequestMessage {
  readonly id?: string
  readonly role?: string
  readonly content?: string | readonly RequestPart[]
  readonly metadata?: Record<string, unknown>
}

export type ImageCandidate = {
  readonly mime: string
  readonly fingerprint: string
  readonly kind: "bytes" | "url"
  readonly messageID?: string
  readonly bytes?: Uint8Array
  readonly url?: string
  readonly filename?: string
}

export function isImageMime(mime: unknown): mime is string {
  return typeof mime === "string" && mime.toLowerCase().startsWith("image/")
}

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex")
}

function toBytes(data: string | Uint8Array): Uint8Array {
  return typeof data === "string" ? Buffer.from(data, "base64") : data
}

function fromMedia(part: RequestPart, messageID?: string): ImageCandidate | undefined {
  const source = part.media?.source
  const dataUrlMime = /^data:(image\/[^;,]+);/i.exec(source?.type === "url" ? (source.url ?? "") : "")?.[1]
  const mime = source?.mediaType ?? part.media?.mediaType ?? dataUrlMime
  if (!isImageMime(mime)) return undefined

  if (source?.type === "base64" || source?.type === "bytes") {
    if (source.data === undefined) return undefined
    const bytes = toBytes(source.data)
    return {
      mime,
      kind: "bytes",
      bytes,
      messageID,
      fingerprint: sha256(bytes),
      filename: part.filename,
    }
  }

  if (source?.type === "url" && typeof source.url === "string") {
    const url = source.url
    // Inline data URLs carry the image itself; everything else is referenced
    // by URL so the mirror can point at the original location.
    const dataUrl = /^data:image\/[^;,]+;base64,(.*)$/s.exec(url)
    if (dataUrl) {
      const bytes = Buffer.from(dataUrl[1]!, "base64")
      return { mime, kind: "bytes", bytes, messageID, fingerprint: sha256(bytes), filename: part.filename }
    }
    return { mime, kind: "url", url, messageID, fingerprint: sha256(url), filename: part.filename }
  }

  // A provider-side media ref has no local bytes and is already known to the
  // provider, so there is nothing useful to mirror.
  return undefined
}

function fromToolResult(part: RequestPart, messageID?: string): ImageCandidate[] {
  if (part.type !== "tool-result" || part.result?.type !== "content") return []
  const value = part.result.value
  if (!Array.isArray(value)) return []
  const found: ImageCandidate[] = []
  for (const item of value) {
    if (!item || typeof item !== "object") continue
    const file = item as { type?: unknown; uri?: unknown; mime?: unknown; name?: unknown }
    if (file.type !== "file" || !isImageMime(file.mime) || typeof file.uri !== "string") continue
    const dataUrl = /^data:image\/[^;,]+;base64,(.*)$/s.exec(file.uri)
    if (dataUrl) {
      const bytes = Buffer.from(dataUrl[1]!, "base64")
      found.push({
        mime: file.mime,
        kind: "bytes",
        bytes,
        messageID,
        fingerprint: sha256(bytes),
        filename: typeof file.name === "string" ? file.name : undefined,
      })
      continue
    }
    found.push({
      mime: file.mime,
      kind: "url",
      url: file.uri,
      messageID,
      fingerprint: sha256(file.uri),
      filename: typeof file.name === "string" ? file.name : undefined,
    })
  }
  return found
}

/** Collect every image reaching the model in a request's messages. */
export function collectImages(messages: readonly RequestMessage[]): ImageCandidate[] {
  const found: ImageCandidate[] = []
  for (const message of messages) {
    const content = message.content
    if (!Array.isArray(content)) continue
    for (const part of content) {
      if (part?.type === "media") {
        const candidate = fromMedia(part, message.id)
        if (candidate) found.push(candidate)
      }
      found.push(...fromToolResult(part, message.id))
    }
  }
  return found
}

type StoredMessage = {
  readonly type?: string
  readonly files?: readonly { readonly data?: unknown; readonly mime?: unknown }[]
  readonly content?: readonly {
    readonly type?: string
    readonly state?: {
      readonly status?: string
      readonly content?: readonly { readonly type?: string; readonly uri?: unknown; readonly mime?: unknown }[]
    }
  }[]
}

/**
 * Fingerprints images already present in persisted chat messages, so an image
 * injected under a different message id is still recognised as "already on
 * screen" and is not mirrored twice.
 */
export function chatFingerprints(messages: readonly unknown[]): ReadonlySet<string> {
  const fingerprints = new Set<string>()
  for (const message of messages) {
    if (!message || typeof message !== "object") continue
    const stored = message as StoredMessage
    if (stored.type === "user" && Array.isArray(stored.files)) {
      for (const file of stored.files) {
        if (!isImageMime(file.mime) || typeof file.data !== "string") continue
        fingerprints.add(sha256(Buffer.from(file.data, "base64")))
      }
    }
    if (stored.type !== "assistant" || !Array.isArray(stored.content)) continue
    for (const part of stored.content) {
      if (part?.type !== "tool" || part.state?.status !== "completed" || !Array.isArray(part.state.content)) continue
      for (const item of part.state.content) {
        if (item?.type !== "file" || !isImageMime(item.mime) || typeof item.uri !== "string") continue
        fingerprints.add(sha256(item.uri))
        // Tool results often store images as data URLs. A context hook sees
        // the decoded bytes, so fingerprint those too or the same image looks
        // new and gets mirrored a second time.
        const dataUrl = /^data:image\/[^;,]+;base64,(.*)$/s.exec(item.uri)
        if (dataUrl) fingerprints.add(sha256(Buffer.from(dataUrl[1]!, "base64")))
      }
    }
  }
  return fingerprints
}

const EXTENSIONS: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/svg+xml": "svg",
  "image/bmp": "bmp",
  "image/avif": "avif",
}

export function imageExtension(candidate: ImageCandidate): string {
  return EXTENSIONS[candidate.mime.toLowerCase()] ?? "img"
}

/** Markdown that the OpenCode chat renderers show as an inline image. */
export function mirrorMarkdown(reference: string, filename?: string): string {
  const alt = filename?.replace(/[[\]]/g, "") ?? "Mirrored image"
  return `![${alt}](${reference})`
}
