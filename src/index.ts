import { createHash } from "node:crypto"
import { promises as fs } from "node:fs"
import os from "node:os"
import path from "node:path"
import { Plugin } from "@opencode/plugin"
import {
  chatFingerprints,
  collectImages,
  imageExtension,
  mirrorMarkdown,
  type ImageCandidate,
  type RequestMessage,
} from "./images.js"

const PLUGIN_ID = "hffmnnj.image-mirror"
const MARKER = "imageMirror"
const LEDGER_PREFIX = "mirrored:"

function mirrorDirectory(): string {
  const root =
    process.env.OPENCODEV2_DATA_HOME ??
    process.env.XDG_DATA_HOME ??
    path.join(os.homedir(), ".local", "share")
  return path.join(root, "opencode", "image-mirror")
}

function noticeID(sessionID: string, fingerprint: string): string {
  const hash = createHash("sha256").update(`${sessionID}:${fingerprint}`).digest("hex")
  return `msg_${hash}`
}

function localPathFor(directory: string, candidate: ImageCandidate): string {
  return path.join(directory, `${candidate.fingerprint}.${imageExtension(candidate)}`)
}

async function referenceFor(directory: string, candidate: ImageCandidate): Promise<string> {
  if (candidate.kind === "url" && candidate.url) return candidate.url
  const target = localPathFor(directory, candidate)
  if (candidate.bytes) {
    await fs.mkdir(directory, { recursive: true })
    await fs.writeFile(target, candidate.bytes)
  }
  return target
}

export default Plugin.define({
  id: PLUGIN_ID,
  async setup(ctx) {
    const directory = mirrorDirectory()

    // The context hook is the ground truth for "what the agent sees": it runs
    // immediately before each model request with the exact message list being
    // dispatched. Images already present in the stored session history are
    // already on screen, so only images introduced outside that history are
    // mirrored into the chat.
    await ctx.session.hook("context", async (event) => {
      const sessionID = String(event.sessionID)
      const messages = event.messages as RequestMessage[]

      let chatMessageIDs: ReadonlySet<string>
      let mirrorMessageIDs: ReadonlySet<string>
      let inChatFingerprints: ReadonlySet<string>
      try {
        const stored = await ctx.session.context({ sessionID: event.sessionID })
        chatMessageIDs = new Set(stored.map((message) => String((message as { id?: unknown }).id)))
        inChatFingerprints = chatFingerprints(stored)
        mirrorMessageIDs = new Set(
          stored
            .filter((message) => (message as { metadata?: Record<string, unknown> }).metadata?.[MARKER] === true)
            .map((message) => String((message as { id?: unknown }).id)),
        )
      } catch (error) {
        console.warn(`${PLUGIN_ID}: could not read session history; skipping mirror pass`, error)
        return
      }

      const ledgerKey = `${LEDGER_PREFIX}${sessionID}`
      let mirrored: string[] = []
      try {
        const storedLedger = await ctx.storage.get(ledgerKey)
        if (Array.isArray(storedLedger)) mirrored = storedLedger.filter((item): item is string => typeof item === "string")
      } catch (error) {
        console.warn(`${PLUGIN_ID}: could not read mirror ledger`, error)
      }
      const seen = new Set(mirrored)

      const unique = new Map<string, ImageCandidate>()
      for (const candidate of collectImages(messages)) {
        if (candidate.messageID && chatMessageIDs.has(candidate.messageID)) continue
        if (candidate.messageID && mirrorMessageIDs.has(candidate.messageID)) continue
        if (inChatFingerprints.has(candidate.fingerprint)) continue
        if (seen.has(candidate.fingerprint)) continue
        if (!unique.has(candidate.fingerprint)) unique.set(candidate.fingerprint, candidate)
      }
      if (unique.size === 0) return

      for (const [fingerprint, candidate] of unique) {
        try {
          const reference = await referenceFor(directory, candidate)
          // A synthetic notice is rendered in the chat as a normal message,
          // but OpenCode lowers its text to a plain TextPart for the model.
          // It therefore carries only a local path, never image bytes, so the
          // mirrored copy is never sent back into the agent's context.
          // `resume: false` keeps it from waking an idle session.
          await ctx.session.synthetic({
            id: noticeID(sessionID, fingerprint) as never,
            sessionID: event.sessionID,
            text: mirrorMarkdown(reference, candidate.filename),
            // Described synthetic messages collapse into a one-line notice,
            // which would hide the image, so this notice has no description.
            metadata: { source: PLUGIN_ID, [MARKER]: true, fingerprint },
            resume: false,
          })
          seen.add(fingerprint)
        } catch (error) {
          console.warn(`${PLUGIN_ID}: failed to mirror image ${fingerprint}`, error)
        }
      }

      if (seen.size !== mirrored.length) {
        try {
          await ctx.storage.set(ledgerKey, [...seen])
        } catch (error) {
          console.warn(`${PLUGIN_ID}: could not persist mirror ledger`, error)
        }
      }
    })
  },
})
