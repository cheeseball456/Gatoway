## Context

`ARCHITECTURE.md` v1.6 revised AD-6/AD-8 and added AD-9 in response to
`REQUIREMENTS.md` v1.2 (FR-007/FR-008), itself raised by QA-018 during live xDender
verification. This design originally translated those decisions into concrete message
shapes, validation rules, and a resolution algorithm addressed by **ordinal array
index**, resolved against whichever physical positions currently held a *placed*
generic action.

**Revised for `ARCHITECTURE.md` v1.7 (QA-020).** Live `/verify` of the resulting
implementation found that ordinal-index-against-current-placement conflates two
different things: a device's fixed physical capacity, and how many generic actions
the user has gotten around to placing so far. The same physical button could mean a
different ordinal index depending on unrelated placement changes elsewhere on the
device. v1.7 fixes this by addressing content with **fixed, stable position labels**
(`"B1"`, `"B2"`, `"D1"`, ...) derived from the device's actual hardware capacity
(`Device.size`/`Device.type`) rather than from live placement. This document now
describes the v1.7 model throughout; the sections below have been rewritten, not
appended to, to avoid describing two competing models.

## Goals / Non-Goals

**Goals:**
- Gatoway core tracks the connected device's fixed physical capacity (from the Stream
  Deck plugin) and forwards it to each application plugin at connect time and on
  every focus change.
- Application plugins declare content addressed by fixed, stable labels — Gatoway
  core never needs to understand what any entry means, and a label always means the
  same physical position for as long as the device itself doesn't change.
- Remove `layout.json` and its entire supporting code/spec in the same change, not as
  follow-up cleanup.

**Non-Goals:**
- Multiple physical Stream Deck devices — the wire shapes below assume exactly one
  device's capacity at a time, matching `ARCHITECTURE.md`'s "does not preclude, does
  not build" stance. No device identifier is added to any message.
- Any UI for a human to override a plugin's own ordering — still deferred (post-MVP,
  per `REQUIREMENTS.md` §2.3).
- Guaranteeing every declared label actually renders — a label with no generic action
  currently placed at its corresponding physical position simply doesn't render,
  exactly as an undeclared label doesn't. The expected setup is that a user places a
  generic Key/Dial action on every physical position, but this is documented guidance,
  not an enforced precondition.
- Changing anything about `focus`, `register_ack`, `error`'s envelope, authentication
  (AD-4/AD-5), or the Stream Deck plugin's supervision/backoff logic — none of this is
  affected.

## Decisions

**D1 — `device_capacity` (Stream Deck plugin → core): the device's fixed physical
layout, not live placement.** Derived once from `Device.size` (button grid rows/
columns) and a `DeviceType` → dial-count mapping (the SDK does not expose dial count
as a runtime field — only in its own enum documentation's prose, e.g. "Stream Deck +
... 4 dials," "Stream Deck Studio ... 2 dials," "Stream Deck + XL ... 6 dials"; the
developer must build this mapping from the SDK's actual documented values, verified
against the installed `@elgato/schemas` package, not guessed or assumed complete from
memory).

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
- Sent once at that connection's own registration, and again only if the connected
  device itself changes (connected, disconnected, or swapped for a different model) —
  **not** on individual action placement/removal, since physical capacity doesn't
  change just because the user added or removed a generic action. This is simpler
  than v1.6's approach: no `willAppear`/`willDisappear` listening is needed at all,
  only device connect/disconnect events.
- Order within each list is still derived deterministically (reading order for keys —
  row ascending, then column ascending; ascending index for dials), because this
  order is what defines which physical position `"B1"`/`"D1"` etc. refer to. Since
  the list is now capacity-derived rather than placement-derived, it no longer
  shuffles due to unrelated placement changes — only a genuine device change ever
  changes it.
- Gatoway core keeps only the *latest* report in memory — never persisted, never
  merged with a prior report. Gatoway core derives each position's label from its
  index in these lists: `buttonPositions[0]` is `"B1"`, `buttonPositions[1]` is
  `"B2"`, ..., `dialPositions[0]` is `"D1"`, and so on (1-based numbering in the
  label, 0-based indexing into the array).

**D2 — `slot_capacity` (core → each application plugin): bare counts only.** An
application plugin derives its own valid label set (`"B1".."B<buttonSlots>"`,
`"D1".."D<dialSlots>"`) from these counts using the documented labeling convention —
the actual label strings are never enumerated over the wire, since both sides derive
them identically from the same counts.

```jsonc
{ "type": "slot_capacity", "connectionId": "abc-123", "payload": { "buttonSlots": 8, "dialSlots": 4 } }
```

- Sent to a connection once immediately after its own successful `register_ack`, and
  again every time Gatoway core records that connection as newly focused (i.e. right
  alongside the existing internal `focus_changed` handling) — never on blur.
- Derived directly from the Stream Deck plugin's latest `device_capacity` report
  (`buttonSlots = buttonPositions.length`, `dialSlots = dialPositions.length`). If no
  `device_capacity` has ever been received yet (e.g. Stream Deck plugin not yet
  connected), both counts are `0`.
- Unchanged in wire shape from the original design — only its *meaning* changed
  (fixed physical capacity, not live placement count).

**D3 — `register`'s capability declaration becomes `content`, a flat label-keyed
map.**

```jsonc
{
  "type": "register",
  "payload": {
    "pluginType": "xdesign",
    "content": {
      "B1": { "icon": "data:image/png;base64,...", "label": "Line", "state": 0 },
      "B2": { "icon": "data:image/png;base64,...", "label": "Rect" },
      "D1": { "label": "Zoom" }
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
type RegisterContent = Record<string, SlotContent>; // keyed by label, e.g. "B1", "D1"
```

- **One flat map, not two arrays.** A label's own prefix (`B` vs `D`) already
  identifies its controller type, so there is no need for separate
  `content.buttons`/`content.dials` containers — confirmed acceptable with the user
  as an implementation detail, as long as documented clearly and applied
  consistently.
- `content` defaults to `{}` if omitted, exactly as `capabilities` defaulted to `[]`
  in the prior design.
- **A plugin need not declare every valid label.** An omitted label (e.g. a device
  with `B1`.."B8" available, but the plugin only declares `B1`-`B3`) simply isn't
  rendered at the remaining positions — they show the idle appearance instead,
  exactly mirroring the prior design's underflow behavior, now expressed as "label
  absent from the map" instead of "array shorter than capacity."
- **No `id` field** on `SlotContent` itself — the label *is* the address; nothing
  else identifies an entry.
- **No `type` field** — implicit from the label's own prefix.
- **No `description` field** — unused today (see prior design rationale, unchanged).
- **Re-sending `register` fully replaces `content`**, exactly as before — omitting
  `content` on a re-registration leaves the previous declaration unchanged; an
  explicit `content` (including `{}`) always replaces it. This remains the **only**
  content-update mechanism (no second, lighter-weight message).
- **Rendered immediately if relevant** — unchanged from the prior design: if the
  sending connection currently has focus, Gatoway core immediately re-derives and
  sends fresh `render_update`s for every label that changed.

**D4 — Validation moves from `Capability` shape to `SlotContent` shape, keyed by
label.** Each entry in `content` is validated independently: the **key** itself must
match the labeling convention for a currently-known-valid label (i.e. `B<n>` where
`1 <= n <= buttonSlots`, or `D<n>` where `1 <= n <= dialSlots`, per the most recent
`device_capacity`) — an unrecognized or out-of-range label is itself a rejection
reason, not just its value. The **value** is validated exactly as before: `label`
non-empty string (required); `icon` a string if present (no `null` at registration);
`state` a number if present, and only valid under a `B`-prefixed key (present under a
`D`-prefixed key is itself a rejection). An invalid entry is dropped from the map (not
the whole registration), reported via the existing `error` message shape with
`rejectedContent: [{ label: string, reason: string }]` (the field addressed by the
label itself now, replacing the prior design's index-based addressing — there is no
index anymore, only the label).

**D5 — `command`'s resolved target becomes the fixed label itself; `controller` is
dropped.**

```jsonc
{
  "type": "command",
  "connectionId": "<focused connection id>",
  "payload": { "label": "B3", "eventType": "keyDown" }
}
```

```ts
interface CommandPayload {
  label: string;         // e.g. "B3", "D1" — the focused connection's own key into its declared content
  eventType: InputEventType;
  delta?: number;
}
```

`controller` is removed as a separate field: the label's own prefix already conveys
whether it's a button or dial, and carrying both would be redundant. This was
confirmed acceptable with the user as an implementation detail, provided it's
documented clearly and used consistently.

**D6 — Resolution algorithm (replaces both `layout.json`-based lookup and v1.6's
ordinal-index lookup).** On `input_event` (unchanged shape — still position-addressed,
since the Stream Deck plugin still deals in real physical positions):

1. Look up the reported `Position` in the Stream Deck plugin's latest
   `device_capacity` report for the matching `controller` type, to find its index N,
   and derive the corresponding label (`"B" + (N+1)` or `"D" + (N+1)`).
2. If the position isn't found there at all (a genuinely unknown/stale position — should
   not normally occur once D1's derivation is correct), log and drop.
3. Otherwise, check whether the *focused* connection's own `content` map has an entry
   for that label.
4. If yes, send that connection a `command` with that `label`. If no (the label isn't
   in the focused connection's declared map — the expected, safe "not declared"
   case), log and drop — nothing to route to.
5. If nothing is focused, log and drop, exactly as today.

`render_update`s to the Stream Deck plugin are derived the same direction in reverse:
for the newly-focused (or content-updated) connection, for each label present in its
`content` map, derive its physical position from the latest `device_capacity` report
(reversing D1's label derivation) and send a `render_update` for that position with
that entry's icon/label/state. Every other physical position within the device's full
capacity (present in `device_capacity` but absent from the connection's `content`
map) is swept to the idle appearance — mirroring today's idle-sweep behavior, driven
by map-key presence instead of array length.

**D7 — `layout.json` and its supporting code are deleted, not deprecated.** Unchanged
from the prior design — see `ARCHITECTURE.md` R-6.

**D8 — (New, v1.7) `willAppear`/`willDisappear`-based placement detection is removed
entirely, not merely unused.** The Stream Deck plugin code added for v1.6 to react to
individual action placement/removal (task 7.3's original scope) is no longer needed,
since D1's capacity derivation no longer depends on placement at all — only on
`Device.size`/`Device.type`, which only change when the device itself changes. This
is a net reduction in code, not a change kept dormant alongside the new mechanism.

## Risks / Trade-offs

- [Risk] No application plugin has shipped against the old protocol outside this
  project's own manual test clients, so there is no real backward-compatibility
  concern to design around.
- [Trade-off] Always resending the full `content` map for any change (D3) costs more
  bytes than a lightweight single-slot update would for a small change — accepted as
  the simpler protocol surface, confirmed with the user (unchanged from the prior
  design).
- [Risk] The `DeviceType` → dial-count mapping (D1) is new, hand-authored reference
  data with no runtime source of truth in the SDK — if Elgato ships a new device
  type, this mapping will be silently wrong (defaulting to whatever fallback the
  developer chooses, e.g. 0 dials) until updated. Not a blocker for this change (only
  the Stream Deck+ model is in active use), but worth a code comment flagging it for
  future maintenance.
- [Trade-off] Not enforcing "every physical position must have a generic action
  placed" at the protocol level (Non-Goals) means a plugin can declare a label that
  never renders because nothing is placed there yet — accepted as consistent with
  this project's established graceful-degradation philosophy (an unbound/unplaced
  position failing safe, not failing loud), and because there is no SDK mechanism to
  enforce or automate full placement anyway (confirmed: no `createAction`/
  programmatic placement API exists in `@elgato/streamdeck`).

## Migration Plan

Not applicable in the data-preservation sense — there is no persisted `content` to
migrate. Any hand-authored `layout.json` a developer has been using during testing
simply stops being read. The manual test clients (`testAppClient.ts`, `tcpTestClient.ts`,
`wsTestClient.ts`) need updating again for the label-keyed `content` map and the new
`command`/`error` shapes — they were already updated once for the v1.6 ordinal model
in this same change; this is a further revision of that same work, not new scope.

## Open Questions

None outstanding — the trade-offs around label-vs-index addressing and dropping
`controller` from `command` were confirmed acceptable with the user during the
architecture session that produced `ARCHITECTURE.md` v1.7, on the condition that the
chosen representation is documented clearly and applied consistently (satisfied by
this document and the delta specs).
