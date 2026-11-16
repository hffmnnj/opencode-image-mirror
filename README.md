<p align="center">
  <img src="https://unpkg.com/hffmnnj.image-mirror/assets/banner.png" alt="Image Mirror for OpenCode" width="100%">
</p>

# Image Mirror for OpenCode

Every image an agent sees should also be visible to the human in the chat. This OpenCode V2 plugin makes that happen without ever sending the image back to the model a second time.

- npm package and plugin ID: `hffmnnj.image-mirror`
- Hooks the `session.context` model request, the exact point where the agent's images are assembled
- Mirrors only images that are **not** already in the user's chat
- Mirrored notices carry a file path, never image bytes, so the agent context stays clean

## Why

Images reach an agent in several ways: attached by a user, returned by a tool, or injected into a request by another plugin's `context` hook. The first two are already rendered in the chat timeline. The third is not — the model sees an image the user never sees.

This plugin closes that gap. It compares each model request against the session's stored history and publishes display-only notices for the images that would otherwise be invisible.

## The context guarantee

A mirror notice is posted with `ctx.session.synthetic({ resume: false })`. OpenCode renders synthetic messages in the chat, but lowers their **text** to a plain text part for the model. The notice contains only a markdown image reference to a local file:

```
![shot.png](/home/me/.local/share/opencode/image-mirror/<sha256>.png)
```

No base64 payload, no media part, no data URL, and no image bytes are added to any model request. The agent therefore never sees a second copy of an image it already received. The plugin also avoids the failure mode of removing notices from a request: removing the last user-role message can break turn ordering for models that require the conversation to end with user input. `resume: false` keeps an idle session asleep, so a mirror never triggers an extra model turn.

## Requirements

OpenCode V2 with `@opencode/plugin` 2.x. No API keys, credentials, or external services are used.

## Install

Add the package to the `plugins` array in your OpenCode config. Keep unrelated entries unchanged.

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": ["hffmnnj.image-mirror"]
}
```

The plugin takes no options. Plugin changes apply after saving the config; use `/reload` if you want to force a full reload.

## How it works

1. A `session.context` hook inspects the outgoing model request for image media parts and image files in tool results.
2. Messages whose IDs are in the stored session history, and images whose fingerprints already appear in stored attachments or tool results, are skipped — they are already on screen.
3. Each remaining image is written once to a stable path under the OpenCode data directory (`$OPENCODEV2_DATA_HOME`, `$XDG_DATA_HOME`, or `~/.local/share`), named by its SHA-256 fingerprint.
4. A display-only synthetic notice with a markdown image reference is posted to the session with `resume: false`.
5. A durable per-session fingerprint ledger prevents re-mirroring on later model calls.

Images referenced by remote URLs are mirrored by reference rather than downloaded.

## What gets mirrored

| Image source | Already in chat? | Action |
| --- | --- | --- |
| User attachment | Yes | Skipped |
| Tool result with an image file | Yes | Skipped |
| Image injected by another plugin's `context` hook | No | Mirrored |
| Image injected under a different message ID | No | Skipped when its bytes match chat history |
| A mirrored image on a later turn | Yes | Skipped by the ledger |

## Privacy

Image bytes are written only to your local OpenCode data directory. Nothing is uploaded, logged, or sent to a third party by this plugin.

## Development

```sh
bun install
bun run check   # typecheck + unit tests
```

Unit tests cover image detection across media parts and tool results, chat-history and fingerprint deduplication, and the invariant that mirror notices contain only paths.

## License

MIT
