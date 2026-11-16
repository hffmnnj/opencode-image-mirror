import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { promises as fs } from "node:fs"
import os from "node:os"
import path from "node:path"

const scratch = await fs.mkdtemp(path.join(os.tmpdir(), "image-mirror-test-"))
process.env.OPENCODEV2_DATA_HOME = scratch

const { default: plugin } = await import("../../src/index.js")

afterAll(async () => {
  await fs.rm(scratch, { recursive: true, force: true })
})

type ContextHook = (event: {
  sessionID: string
  messages: Array<Record<string, unknown>>
}) => Promise<void> | void

const PNG_A = Buffer.from("image-alpha")
const PNG_B = Buffer.from("image-beta")

function mediaMessage(id: string | undefined, data: Buffer) {
  return {
    id,
    role: "user",
    content: [
      {
        type: "media",
        media: {
          mediaType: "image/png",
          source: { type: "base64", data: data.toString("base64"), mediaType: "image/png" },
        },
        filename: "shot.png",
      },
    ],
  }
}

function makeContext(storedMessages: Array<Record<string, unknown>>) {
  const contextHooks: ContextHook[] = []
  const synthetics: Array<Record<string, unknown>> = []
  const store = new Map<string, unknown>()

  const ctx = {
    session: {
      hook: async (name: string, callback: ContextHook) => {
        if (name === "context") contextHooks.push(callback)
        return { dispose: async () => {} }
      },
      context: async () => storedMessages,
      synthetic: async (input: Record<string, unknown>) => {
        synthetics.push(input)
        return input
      },
    },
    storage: {
      get: async (key: string) => store.get(key),
      set: async (key: string, value: unknown) => void store.set(key, value),
    },
  }
  return { ctx, contextHooks, synthetics }
}

describe("plugin context hook", () => {
  test("mirrors only images that are not already in the chat, once", async () => {
    const { ctx, contextHooks, synthetics } = makeContext([
      {
        id: "msg_stored",
        type: "user",
        metadata: {},
        content: [],
        files: [{ data: PNG_A.toString("base64"), mime: "image/png" }],
      },
    ])
    await plugin.setup(ctx as never)
    expect(contextHooks).toHaveLength(1)

    const event = {
      sessionID: "ses_test",
      messages: [
        mediaMessage("msg_stored", PNG_A), // already rendered in chat
        mediaMessage(undefined, PNG_A), // injected duplicate of the stored image
        mediaMessage("msg_injected", PNG_B), // injected, genuinely new
      ],
    }

    await contextHooks[0]!(event)
    expect(synthetics).toHaveLength(1)

    const notice = synthetics[0]!
    expect(notice.resume).toBe(false)
    expect((notice.metadata as Record<string, unknown>).imageMirror).toBe(true)
    const text = notice.text as string
    expect(text).toMatch(/^!\[shot\.png\]\(/)
    expect(text).not.toContain(PNG_A.toString("base64"))
    expect(text).not.toContain(PNG_B.toString("base64"))
    expect(text).not.toMatch(/data:image/i)

    // A second request must not mirror the same image again.
    await contextHooks[0]!(event)
    expect(synthetics).toHaveLength(1)
  })

  test("does nothing when every image is already in stored history", async () => {
    const { ctx, contextHooks, synthetics } = makeContext([{ id: "msg_stored", metadata: {}, content: [] }])
    await plugin.setup(ctx as never)
    await contextHooks[0]!({
      sessionID: "ses_other",
      messages: [mediaMessage("msg_stored", PNG_A)],
    })
    expect(synthetics).toHaveLength(0)
  })
})
