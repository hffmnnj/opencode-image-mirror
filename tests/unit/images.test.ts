import { describe, expect, test } from "bun:test"
import {
  chatFingerprints,
  collectImages,
  imageExtension,
  isImageMime,
  mirrorMarkdown,
  type RequestMessage,
} from "../../src/images.js"

describe("isImageMime", () => {
  test("accepts image mimes case-insensitively", () => {
    expect(isImageMime("image/png")).toBe(true)
    expect(isImageMime("IMAGE/WEBP")).toBe(true)
  })

  test("rejects non-image mimes and non-strings", () => {
    expect(isImageMime("application/pdf")).toBe(false)
    expect(isImageMime(undefined)).toBe(false)
  })
})

describe("collectImages", () => {
  test("finds base64 media parts and fingerprints their decoded bytes", () => {
    const bytes = Buffer.from("fake-png-bytes")
    const messages: RequestMessage[] = [
      {
        id: "msg_generated",
        content: [
          { type: "text", text: "look" },
          {
            type: "media",
            filename: "shot.png",
            media: { source: { type: "base64", data: bytes.toString("base64"), mediaType: "image/png" } },
          },
        ],
      },
    ]

    const images = collectImages(messages)
    expect(images).toHaveLength(1)
    expect(images[0]!.mime).toBe("image/png")
    expect(images[0]!.kind).toBe("bytes")
    expect(images[0]!.messageID).toBe("msg_generated")
    expect(images[0]!.filename).toBe("shot.png")
    expect(Buffer.from(images[0]!.bytes!)).toEqual(bytes)
    expect(images[0]!.fingerprint).toMatch(/^[a-f0-9]{64}$/)
  })

  test("finds image files inside tool results", () => {
    const messages: RequestMessage[] = [
      {
        id: "msg_tool",
        content: [
          {
            type: "tool-result",
            result: {
              type: "content",
              value: [
                { type: "text", text: "done" },
                { type: "file", uri: "file:///tmp/chart.png", mime: "image/png", name: "chart.png" },
                { type: "file", uri: "file:///tmp/notes.txt", mime: "text/plain" },
              ],
            },
          },
        ],
      },
    ]

    const images = collectImages(messages)
    expect(images).toHaveLength(1)
    expect(images[0]!.url).toBe("file:///tmp/chart.png")
    expect(images[0]!.messageID).toBe("msg_tool")
  })

  test("ignores text-only messages and provider media refs", () => {
    const messages: RequestMessage[] = [
      { id: "a", content: "plain text" },
      {
        id: "b",
        content: [
          { type: "media", media: { source: { type: "ref", provider: "openai", id: "abc", mediaType: "image/png" } } },
        ],
      },
    ]
    expect(collectImages(messages)).toHaveLength(0)
  })

  test("decodes inline data URLs into bytes", () => {
    const bytes = Buffer.from("gif-bytes")
    const messages: RequestMessage[] = [
      {
        content: [
          {
            type: "media",
            media: { source: { type: "url", url: `data:image/gif;base64,${bytes.toString("base64")}` } },
          },
        ],
      },
    ]
    const images = collectImages(messages)
    expect(images).toHaveLength(1)
    expect(images[0]!.kind).toBe("bytes")
    expect(Buffer.from(images[0]!.bytes!)).toEqual(bytes)
  })
})

describe("chat fingerprints", () => {
  test("recognises an image stored as a tool-result data URL", () => {
    const bytes = Buffer.from("stored-jpeg-bytes")
    const stored = [
      {
        id: "msg_tool",
        type: "assistant",
        content: [
          {
            type: "tool",
            state: {
              status: "completed",
              content: [
                {
                  type: "file",
                  mime: "image/jpeg",
                  uri: `data:image/jpeg;base64,${bytes.toString("base64")}`,
                },
              ],
            },
          },
        ],
      },
    ]
    const candidate = collectImages([
      {
        id: "msg_injected",
        content: [
          {
            type: "media",
            media: {
              mediaType: "image/jpeg",
              source: { type: "base64", data: bytes.toString("base64"), mediaType: "image/jpeg" },
            },
          },
        ],
      },
    ])[0]!

    expect(chatFingerprints(stored).has(candidate.fingerprint)).toBe(true)
  })

  test("recognises an image stored as a user attachment", () => {
    const bytes = Buffer.from("attached-png")
    const stored = [
      { id: "msg_user", type: "user", files: [{ data: bytes.toString("base64"), mime: "image/png" }] },
    ]
    const candidate = collectImages([
      {
        content: [
          {
            type: "media",
            media: {
              mediaType: "image/png",
              source: { type: "bytes", data: bytes, mediaType: "image/png" },
            },
          },
        ],
      },
    ])[0]!

    expect(chatFingerprints(stored).has(candidate.fingerprint)).toBe(true)
  })
})

describe("mirror rendering", () => {
  test("uses a stable extension per mime", () => {
    expect(imageExtension({ mime: "image/jpeg" } as never)).toBe("jpg")
    expect(imageExtension({ mime: "image/webp" } as never)).toBe("webp")
    expect(imageExtension({ mime: "image/x-custom" } as never)).toBe("img")
  })

  test("renders a markdown image with a sanitised alt label", () => {
    expect(mirrorMarkdown("/tmp/shot.png", "a[b].png")).toBe("![ab.png](/tmp/shot.png)")
    expect(mirrorMarkdown("/tmp/shot.png")).toBe("![Mirrored image](/tmp/shot.png)")
  })

  test("mirror text is a path only, never an embedded image payload", () => {
    const text = mirrorMarkdown("/home/me/.local/share/opencode/image-mirror/abc.png", "chart.png")
    expect(text).not.toMatch(/data:image|base64,/i)
    expect(text).toContain("/home/me/.local/share/opencode/image-mirror/abc.png")
  })
})
