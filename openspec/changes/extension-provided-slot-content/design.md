## Context

`ARCHITECTURE.md` v1.6 revised AD-6/AD-8 and added AD-9 in response to
`REQUIREMENTS.md` v1.2 (FR-007/FR-008), itself raised by QA-018 during live xDender
verification. This design translates those decisions into concrete message shapes,
validation rules, and a resolution algorithm — and specifies exactly what gets removed.

## Goals / Non-Goals

**Goals:**
- Gatoway core tracks live slot capacity (from the Stream Deck plugin) and forwards
  it to each application plugin at connect time and on every focus change.
- Application plugins declare content sized to that capacity, addressed ordinally —
  Gatoway core never needs to understand what any entry means.
- Remove `layout.json` and its entire supporting code/spec in the same change, not as
  follow-up cleanup.

**Non-Goals:**
- Multiple physical Stream Deck devices — the wire shapes below assume exactly one
  device's capacity at a time, matching `ARCHITECTURE.md`'s "does not preclude, does
  not build" stance. No device identifier is added to any message.
- Any UI for a human to override a plugin's own ordering — still deferred (post-MVP,
  per `REQUIREMENTS.md` §2.3).
- Changing anything about `focus`, `register_ack`, `error`'s envelope, authentication
  (AD-4/AD-5), or the Stream Deck plugin's supervision/backoff logic — none of this is
  affected.

## Decisions

**D1 — `device_capacity` (Stream Deck plugin → core): carries ordered position lists,
not bare counts.** Gatoway core needs the actual physical position for each ordinal
slot index, to translate an application's ordinally-addressed content into
position-addressed `render_update`s for the Stream Deck plugin. A bare count would be
enough for the app-plugin-facing side (`slot_capacity`, D2) but not for this side.

```jsonc
{
  "type": "device_capacity",
  "payload": {
    "buttonPositions": [{ "row": 0, "column": 0 }, { "row": 0, "column": 1 }],
    "dialPositions": [{ "index": 0 }, { "index": 1 }]
  }
}
```

- Sent only by the `pluginType: "stream-deck"` connection; rejected/ignored from any
  other connection (mirrors the existing rule that only that connection ever receives
  `render_update`).
- Sent once at that connection's own registration, and again any time the set of
  placed generic actions changes (an action added/removed, a device connected or
  disconnected) — event-driven, matching AD-9. The Elgato SDK already exposes
  everything needed: `Device.size`/`type` and a live `actions` iterator over what's
  currently placed.
- Order within each list must be stable and deterministic (e.g. reading order:
  top-to-bottom, then left-to-right for keys; ascending index for dials) so that
  ordinal index N consistently means the same physical position across repeated
  reports, until capacity actually changes.
- Gatoway core keeps only the *latest* report in memory — never persisted, never
  merged with a prior report.

**D2 — `slot_capacity` (core → each application plugin): bare counts only.** An
application plugin has no use for actual physical positions — only how many slots of
each type it has to fill.

```jsonc
{ "type": "slot_capacity", "connectionId": "abc-123", "payload": { "buttonSlots": 8, "dialSlots": 4 } }
```

- Sent to a connection once immediately after its own successful `register_ack`, and
  again every time Gatoway core records that connection as newly focused (i.e. right
  alongside the existing internal `focus_changed` handling) — never on blur.
- Derived directly from the Stream Deck plugin's latest `device_capacity` report
  (`buttonSlots = buttonPositions.length`, `dialSlots = dialPositions.length`). If no
  `device_capacity` has ever been received yet (e.g. Stream Deck plugin not yet
  connected), both counts are `0` — an application plugin declaring content against a
  capacity of zero simply has nothing rendered yet, which is safe, existing,
  understood behavior (matches today's "nothing bound yet" fallback).

**D3 — `register`'s capability declaration becomes `content`, addressed ordinally.**

```jsonc
{
  "type": "register",
  "payload": {
    "pluginType": "xdesign",
    "content": {
      "buttons": [
        { "icon": "data:image/png;base64,...", "label": "Line", "state": 0 },
        { "icon": "data:image/png;base64,...", "label": "Rect" }
      ],
      "dials": [
        { "label": "Zoom" }
      ]
    },
    "token": "…"
  }
}
```

```ts
interface SlotContent {
  icon?: string;    // string if present; no null at declaration time (matches today's Capability.icon rule)
  label: string;    // non-empty
  state?: number;   // buttons only — no dial equivalent, matching render_update's existing state rule
}
```

- `content.buttons`/`content.dials` each default to `[]` if omitted, exactly as
  `capabilities` defaults to `[]` today.
- **No `id` field.** Nothing addresses an entry by identity — only by its position
  within its array. This is the core simplification: Gatoway core never stores or
  looks up anything by a plugin-chosen string.
- **No `type` field on each entry** — which array an entry is in (`buttons` vs
  `dials`) *is* its type. `Capability.type` is removed as redundant.
- **No `description` field** — carried no rendering behavior today (`docs/PROTOCOL.md`
  called it "not currently rendered... available for a future Property Inspector or
  tooltip use" — speculative and unused); dropped rather than carried forward
  unused, consistent with not over-engineering for a need that hasn't arisen.
- **Re-sending `register` fully replaces `content`**, exactly as `capabilities` is
  replaced today — omitting `content` on a re-registration leaves the previous
  declaration unchanged; an explicit `content` (including empty arrays) always
  replaces it. This is now the **only** mechanism for a content change: a live
  label/state update, paging to a different subset, entering or leaving a nested
  group (FR-008) — no second, lighter-weight update message is added (confirmed with
  the user as the preferred trade-off: simpler protocol surface over smaller
  messages for small changes).
- **Rendered immediately if relevant** — if the sending connection currently has
  focus, Gatoway core immediately re-derives and sends the Stream Deck plugin fresh
  `render_update`s for every slot that changed, exactly as `capability_update`
  triggers an immediate re-render today. If not focused, the new content is simply
  stored for next time that connection gains focus.

**D4 — Validation moves from `Capability` shape to `SlotContent` shape.** Each entry
in `content.buttons`/`content.dials` is validated independently: `label` non-empty
string (required); `icon` a string if present (no `null` at registration, matching
today's rule); `state` a number if present, buttons only (an entry in `content.dials`
with a `state` field is itself a validation failure for that entry — dials have no
state concept, matching `render_update`'s existing keys-only rule). An invalid entry
is dropped from its array (not the whole registration), reported via the existing
`error` message shape with `rejectedContent: [{ controller: "keypad" | "encoder",
index: number, reason: string }]` (renamed from today's `rejectedCapabilities`, same
index-based addressing — no `id` existed to report by, so this is a naming change
only, not a new pattern).

**D5 — `command`'s resolved target becomes an ordinal slot index.**

```jsonc
{
  "type": "command",
  "connectionId": "<focused connection id>",
  "payload": { "controller": "keypad", "slotIndex": 2, "eventType": "keyDown" }
}
```

```ts
interface CommandPayload {
  controller: Controller;
  slotIndex: number;    // ordinal position within the focused connection's own content.buttons/content.dials
  eventType: InputEventType;
  delta?: number;
}
```

**D6 — Resolution algorithm (replaces the `layout.json`-based lookup in
`profileRouter.ts`).** On `input_event` (unchanged shape — still position-addressed,
since the Stream Deck plugin still deals in real physical positions):

1. Look up the reported `Position` in the Stream Deck plugin's latest
   `device_capacity` report for the matching `controller` type, to find its ordinal
   index N (e.g. `buttonPositions.indexOf(position)`).
2. If the position isn't found there at all (stale/unplaced), log and drop — same
   "safely ignored" philosophy as today.
3. Otherwise, check whether the *focused* connection's own `content.buttons`/
   `content.dials` array has an entry at index N.
4. If yes, send that connection a `command` with `slotIndex: N`. If no (the focused
   connection's content is shorter than the physical capacity — underflow, entirely
   expected per FR-007), log and drop — nothing to route to.
5. If nothing is focused, log and drop, exactly as today.

`render_update`s to the Stream Deck plugin are derived the same direction in reverse:
for the newly-focused (or content-updated) connection, for each index N present in
its `content.buttons`/`content.dials`, look up `buttonPositions[N]`/`dialPositions[N]`
from the latest `device_capacity` report and send a `render_update` for that physical
position with that entry's icon/label/state. Indices beyond the connection's declared
content, up to the physical capacity, are swept to the idle appearance — exactly
mirroring today's idle-sweep behavior, just driven by array length instead of a
missing layout binding.

**D7 — `layout.json` and its supporting code are deleted, not deprecated.** Per
`ARCHITECTURE.md` R-6: `gatoway-core/src/routing/layoutConfig.ts`, `layoutStore.ts`,
their tests, the `GATOWAY_LAYOUT_FILE` environment variable, and the
`layout-persistence` capability's spec are all removed in this same change. Leaving
the file-reading code in place alongside the new mechanism would let a stale
`layout.json` silently do nothing (harmless) but would also leave dead code and a
still-documented-but-lying file format in the tree — worse than a clean removal.

## Risks / Trade-offs

- [Risk] No application plugin has shipped against the old protocol outside this
  project's own manual test clients, so there is no real backward-compatibility
  concern to design around — confirmed via `REQUIREMENTS.md`'s own stated scope
  (Lightroom and xDesign, both still in active development against Gatoway directly).
- [Trade-off] Always resending the full `content` array for any change (D3) costs
  more bytes than a lightweight single-slot update would for a small change (e.g. a
  photo-counter label ticking up) — accepted as the simpler protocol surface,
  confirmed with the user.
- [Trade-off] `device_capacity`'s position lists (D1) assume a single device and a
  stable enumeration order the Stream Deck plugin must establish itself (the Elgato
  SDK's own `actions` iterator order is not documented as stable) — the developer
  should pick and document one deterministic rule (e.g. sort by row then column) so
  ordinal indices don't shuffle between reports for no reason.

## Migration Plan

Not applicable in the data-preservation sense — there is no persisted `content` to
migrate, since none was ever persisted (AD-6). Any hand-authored `layout.json` a
developer has been using during testing simply stops being read; this is expected and
matches this change's entire purpose. The manual test clients
(`gatoway-core/test/manual/testAppClient.ts`, `tcpTestClient.ts`, `wsTestClient.ts`)
need updating to speak the new `register` shape and to exercise `device_capacity`/
`slot_capacity`, since they are this project's only current stand-ins for a real
plugin's TCP/WS behavior.

## Open Questions

None outstanding — the two genuinely contested trade-offs (unified vs. two-tier
update mechanism; focus-gain capacity refresh) were resolved with the user during the
architecture session that produced `ARCHITECTURE.md` v1.6 (AD-6, AD-9).
