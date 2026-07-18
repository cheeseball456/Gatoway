## Why

Live verification with a real third-party plugin (xDender) surfaced QA-018: the
protocol has no way for a plugin to provide layout information, so binding a
capability to a physical position required a human to hand-author `layout.json`
using that plugin's exact internal capability id strings — knowledge realistic only
for the plugin's own author, not for Gatoway's operator. `REQUIREMENTS.md` v1.2
(FR-007/FR-008) and `ARCHITECTURE.md` v1.6 (AD-6/AD-8 revised, AD-9 added) resolve this:
Gatoway core tells each plugin how many button/dial slots are physically available
(live, from the Stream Deck plugin), and the plugin declares content sized to fit,
managing its own paging/grouping internally. Gatoway core no longer needs to
understand "capabilities" as a concept at all — only slot content and slot
interaction.

This change implements that model and, in the same step, removes the
`persisted-layout-config` mechanism it fully supersedes — leaving both live at once
would let a plugin author follow now-incorrect documentation.

## What Changes

- **New: the Stream Deck plugin reports live slot capacity to Gatoway core**
  (`device_capacity`) — the ordered list of physical positions currently holding a
  generic Key action, and the ordered list currently holding a generic Dial action.
  Sent once at the Stream Deck plugin's own registration, and again whenever it
  changes (an action placed/removed, a device connected/disconnected).
- **New: Gatoway core forwards slot capacity to each application plugin**
  (`slot_capacity`) — just the counts (button slots, dial slots), at that plugin's own
  connection time and again every time it reports gaining focus.
- **Changed: `register`'s capability declaration becomes ordinal, position-agnostic
  content.** `capabilities: Capability[]` (with `id`/`type`) is replaced by
  `content: { buttons: SlotContent[], dials: SlotContent[] }` — each entry is
  addressed only by its position within its array (0, 1, 2...), never by a semantic
  id. Re-sending `register` continues to fully replace the previous declaration,
  exactly as today — this is now the *only* mechanism for any content change (a live
  label/icon update, paging, entering/leaving a nested group). No new update message
  type is added.
- **Removed: `capability_update`.** Fully superseded by re-`register`.
- **Changed: `command`'s resolved target is an ordinal slot index, not a
  `capabilityId`.** Gatoway core resolves a physical position to "ordinal index N of
  the focused connection's declared content for that controller type," never to any
  app-specific meaning.
- **Removed entirely: `layout.json` and everything built for it** —
  `gatoway-core/src/routing/layoutConfig.ts`, `layoutStore.ts`, the capability-id
  lookup path in `profileRouter.ts`, and the `layout-persistence` capability's spec.
  Gatoway core persists no app-specific configuration to disk as of this change.
- **Redesigned: capability/content validation.** `capabilityValidation.ts` validated
  a `Capability` shape (id/label/type/description/icon/state) that no longer exists;
  replaced with validation of the new `SlotContent` shape (icon/label/state — `type`
  is now implicit from which array an entry is in, `id`/`description` are dropped as
  unused).
- **Docs:** `docs/PROTOCOL.md` rewritten for the new message set (including icon
  pixel-dimension guidance in its existing "Icon and label content" section, raised
  separately during this change's own planning); `docs/LAYOUT_CONFIG.md` removed
  entirely, along with every cross-reference to it.

## Capabilities

### Modified Capabilities
- `message-protocol`: `register`'s content shape, `command`'s payload, and the
  validation/error-reporting requirements are all rewritten; `capability_update` is
  removed.
- `profile-routing`: resolution requirements rewritten for ordinal-index addressing
  instead of capability-id/layout-file lookup.
- `stream-deck-core-lifecycle`: adds the requirement that the Stream Deck plugin
  detects and reports live slot capacity to Gatoway core.

### Removed Capabilities
- `layout-persistence`: fully removed. No requirement in this capability survives —
  Gatoway core persists no layout/capability configuration to disk as of this change.

## Impact

- `gatoway-core/src/protocol/messages.ts`, `capabilityValidation.ts` (rewritten,
  likely renamed), `connection/messageHandler.ts`, `routing/profileRouter.ts`
  (rewritten resolution logic), `routing/layoutConfig.ts` + `layoutStore.ts` (deleted).
- `stream-deck-plugin/src/coreClient/*` (new outbound `device_capacity` reporting,
  driven by the Elgato SDK's device/action info already partially used today).
- `docs/PROTOCOL.md` (rewritten), `docs/LAYOUT_CONFIG.md` (deleted).
- Any application plugin already speaking the old protocol (none shipped yet outside
  this project's own manual test clients) would need to adopt the new `register`
  content shape and drop any reliance on `capability_update`/`capabilityId`.
