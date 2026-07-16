# Gatoway Message Protocol Reference

Covers the full message contract as of `extension-provided-slot-content`, which replaced
the earlier `Capability`/`capability_update`/`capabilityId` model with ordinal,
position-agnostic `content` plus live slot-capacity reporting (`device_capacity`/
`slot_capacity`). If you are writing a new application plugin (following Lightroom or
xDesign), this document should be the only thing you need to read to speak Gatoway's
wire protocol — you should not need to read Gatoway core's source. Kept in sync with
`gatoway-core/src/protocol/messages.ts`, the single source of truth for these shapes; if
the two ever disagree, the source wins and this document is stale.

Speaking the wire protocol correctly is now also *sufficient* to see something render —
unlike the old model, there is no separate, host-side layout/config file to hand-author
in addition to this wire contract. Gatoway core tells each application plugin how many
button/dial slots are currently available (`slot_capacity`, derived from the Stream Deck
plugin's own live `device_capacity` report) and renders whatever ordered content that
plugin declares directly against those slots, addressed purely by ordinal position — see
[Slot capacity and ordinal content](#slot-capacity-and-ordinal-content) below.

## Transport and framing

Gatoway core exposes two listeners, both bound to IPv4 loopback (`127.0.0.1`) only:

- **TCP**, newline-delimited JSON ("NDJSON"): one JSON object per line, each line
  terminated by `\n`. Used by native (non-browser) plugins, e.g. the Lightroom Lua
  plugin and the Stream Deck plugin itself.
- **WebSocket**: one JSON object per WebSocket text frame (no NDJSON framing — the
  frame boundary *is* the message boundary). Used by browser-based plugins, e.g. the
  xDender browser extension.

Message-handling logic is identical across both transports — only the connection-accept
and authentication code differs (see [Authentication and registration](#authentication-and-registration) below).

### Connecting: host and ports

- **TCP** listens on `127.0.0.1:47821` by default, overridable via the `GATOWAY_TCP_PORT`
  environment variable.
- **WebSocket** listens on `127.0.0.1:47822` by default, overridable via the
  `GATOWAY_WS_PORT` environment variable — connect to `ws://127.0.0.1:47822`.
- Both env vars follow the same override pattern as Gatoway core's other `GATOWAY_*`
  settings (e.g. `GATOWAY_TOKEN_FILE`, `GATOWAY_ALLOWED_ORIGINS`): optional, falling back
  to the default above when unset.
- The WebSocket listener does not inspect the upgrade request's URL path — any path on
  the WebSocket port is accepted (`ws://127.0.0.1:47822/` and
  `ws://127.0.0.1:47822/anything` are equally valid). Only the port and the `Origin`
  header (see below) matter.

## Message envelope

Every message, on both transports, is a single JSON object with this shape:

```jsonc
{
  "type": "register",       // string, required: the message type discriminator
  "connectionId": "abc-123", // string, optional: which connection this message concerns
  "payload": { }             // object, required: type-specific payload (see below)
}
```

- `type` must be a non-empty string. The envelope itself does not restrict which
  values are valid — new message types (including ones a future application plugin
  might need) round-trip through it without any change to the envelope.
- `connectionId` is optional. On messages *sent by* Gatoway core to a specific
  connection, it is set to that connection's own ID (e.g. `register_ack`,
  `render_update`, `command`). On messages a plugin sends *to* Gatoway core, it is
  typically omitted (Gatoway core already knows which connection sent it, from the
  socket the message arrived on).
- `payload` must be a JSON object (never an array, string, or other primitive), even
  if a given message type has no meaningful fields.

## Authentication and registration

### `register` (plugin → core)

Sent once, immediately after connecting, to authenticate and declare the plugin's
displayed content.

```jsonc
{
  "type": "register",
  "payload": {
    "pluginType": "lightroom",       // string, required: identifies the kind of plugin
    "content": {                     // RegisterContent, optional (each array defaults to [])
      "buttons": [
        { "label": "Next Photo" }
      ],
      "dials": []
    },
    "token": "…"                     // string, required for TCP; omitted for WebSocket
  }
}
```

- **TCP (native) connections** must present `token`, read from Gatoway core's
  auth-token file (a random secret regenerated every time Gatoway core starts, written
  with user-only read permission). An invalid or missing token is rejected.
- **WebSocket (browser) connections** authenticate via the `Origin` header at the
  HTTP-upgrade stage, before this message is even sent — `token` is not required (and
  is ignored if present) on this transport. The header is checked against
  `GATOWAY_ALLOWED_ORIGINS`, a comma-separated allowlist supporting two entry shapes
  (wildcard-origin-allowlist):
  - An **exact-match** entry (e.g. `chrome-extension://<id>`) matches only that literal
    origin. Recommended for Chrome, whose published/signed extension id is deterministic
    and stable across every install — pin it precisely.
  - A **trailing-wildcard** entry (e.g. `moz-extension://*`) matches any origin sharing
    the prefix before the `*`. Recommended for Firefox: per Mozilla's own documentation,
    Firefox generates a random internal UUID for every installation of an extension, and
    that UUID (not any static id set in the manifest) is what appears in the `Origin`
    header, so an exact-match entry can never be correctly pre-configured for a Firefox
    extension. Only a single trailing `*` is supported — this is a prefix match, not a
    general glob/regex.
  - Exporting `GATOWAY_ALLOWED_ORIGINS` directly works for a manually-started standalone
    `gatoway-core` process, but not for the common case of Gatoway core spawned by the
    Stream Deck application: a GUI-launched process never inherits a shell's exported
    environment variables, so this variable is silently never set that way. See
    [`stream-deck-plugin/README.md`'s "Allowing browser-based (WebSocket) plugins:
    `allowed-origins.json`" section](../stream-deck-plugin/README.md#allowing-browser-based-websocket-plugins-allowed-originsjson)
    for the local config file that plugin reads instead, and forwards into its spawned
    Gatoway core child's environment.
- Sending `register` again on an already-authenticated connection re-declares its
  content without repeating the credential check. Omitting `content` on a
  re-registration leaves the previously-declared content unchanged; an explicit
  `content` (including empty arrays) always replaces it. **This is the only mechanism
  for any content change** — a live label/state update, paging to a different subset,
  or entering/leaving a nested group — there is no separate, lighter-weight update
  message; a plugin always re-sends its complete, current `content`. This is distinct
  from **reconnecting** — a brand-new connection opened after a prior one disconnected.
  A new connection always starts from nothing (no content, no `pluginType`) regardless
  of what any previous, now-disconnected connection had declared, so it must send a full
  `register` of its own — see [Reconnection](#reconnection) below.
- `pluginType` is a free-form string identifying the *kind* of plugin (e.g.
  `"lightroom"`, `"xdesign"`, `"stream-deck"` — the last one reserved for the Stream
  Deck plugin itself, which is the only connection Gatoway core ever sends
  `render_update` to, and which declares no `content` of its own). It is never used as,
  or derived from, the connection's unique ID — multiple simultaneous connections may
  share the same `pluginType`.
- **Each `content.buttons`/`content.dials` entry is validated against the
  `SlotContent` shape below.** An entry that fails validation (e.g. a missing `label`,
  or a `state` field on a dial entry) is *dropped* from its own array — it does **not**
  fail the whole registration. The connection still authenticates and registers
  successfully with whatever valid entries remain (even if that's none of them), and
  Gatoway core sends a follow-up [`error`](#error-either-direction) message afterward
  (after `register_ack`) identifying which entries were rejected and why. See
  [Content validation errors](#content-validation-errors) below for the exact shape.

#### `RegisterContent` / `SlotContent`

```ts
interface RegisterContent {
  buttons: SlotContent[];   // defaults to [] if omitted
  dials: SlotContent[];     // defaults to [] if omitted
}

interface SlotContent {
  icon?: string;    // string if present — register-time `icon` does not accept `null`
  label: string;    // non-empty; human-readable name
  state?: number;   // buttons only — a dial (content.dials) entry with `state` is rejected
}
```

**No `id` field, and no `type` field on each entry.** Nothing addresses a `SlotContent`
entry by identity — only by its ordinal position within its own array
(`content.buttons[0]`, `content.buttons[1]`, …). Which array an entry lives in *is* its
type, so there is no separate `type` field either — the old `Capability.id`/`.type`
fields (and `.description`, which carried no rendering behavior) are gone entirely.
Gatoway core never stores or looks up anything by a plugin-chosen string; see
[Slot capacity and ordinal content](#slot-capacity-and-ordinal-content) below for how
this ordinal addressing actually resolves to a physical position.

`icon` here is a plain optional string, not the `string | null | undefined` three-way
distinction `render_update` uses on the wire (see below) — declaring fresh `content`
(the only content-update mechanism now) is always a full replacement, never a sparse
patch, so there is no separate "explicitly reset to nothing" value needed at this level.
See [Icon and label content](#icon-and-label-content) for format, pixel-dimension, and
length guidance that applies to `icon`/`label` everywhere they appear in the protocol —
at registration and in `render_update`.

### `register_ack` (core → plugin)

Sent in response to every `register` message.

```jsonc
{
  "type": "register_ack",
  "connectionId": "abc-123",
  "payload": {
    "status": "ok",           // "ok" | "rejected"
    "connectionId": "abc-123",
    "reason": "invalid_token" // present only when status is "rejected"
  }
}
```

A `"rejected"` status is always followed by Gatoway core closing the connection.

### `error` (either direction)

A generic protocol-level error report. Gatoway core sends this to an already-
authenticated connection that sends a malformed message (e.g. invalid JSON, or a
payload that isn't a JSON object); a connection that hasn't authenticated yet is
simply disconnected instead, with no `error` sent first. It is also reused, unchanged in
shape, to report semantically-invalid-but-well-formed payload contents — specifically,
rejected `register` content entries (see
[Content validation errors](#content-validation-errors) below) — rather than inventing
a second message type for that purpose.

```jsonc
{
  "type": "error",
  "connectionId": "abc-123",
  "payload": { "message": "malformed message: …", "details": { } }
}
```

**Application plugins should handle unsolicited `error` messages on their own
connection**, not just responses to something they just sent. A `register`'s rejected
content entries are reported this way, as a follow-up message rather than inline in
`register_ack` — a plugin that only reads the message type it expects next (e.g. only
ever looking for `register_ack` immediately after sending `register`) will silently miss
this feedback entirely, exactly as it would have silently missed the underlying data
problem before this validation existed. Read every message that arrives on your
connection, not just the one you're currently waiting on.

#### Content validation errors

A `register` with one or more malformed `content.buttons`/`content.dials` entries
produces a follow-up `error` message with structured `details`, always sent *after*
`register_ack` — the connection itself was never at fault, so authentication/storage
proceeds normally; only the specific rejected entry is reported separately (see
[`RegisterContent`/`SlotContent`](#registercontent--slotcontent) above for the shape
being validated against):

```jsonc
{
  "type": "error",
  "connectionId": "abc-123",
  "payload": {
    "message": "one or more declared content entries were invalid and have been dropped from the connection's content",
    "details": {
      "rejectedContent": [
        { "controller": "keypad", "index": 2, "reason": "\"label\" must be a non-empty string" }
      ]
    }
  }
}
```

`controller` (`"keypad"` for a `content.buttons` entry, `"encoder"` for a
`content.dials` entry) plus `index` — the entry's position within that array as sent
(0-based) — together identify the rejected entry; there is no `id` to report by, since
none exists at this shape. Registration still succeeds with every *other*, validly-shaped
entry in both arrays — even if every entry was rejected, the connection registers with
empty content rather than failing outright.

## Focus tracking

### `focus` (application plugin → core)

Sent by an application plugin any time its own focus state changes (e.g. the
application's window gains or loses OS-level focus, or a browser tab becomes
active/inactive). There is no acknowledgement message.

```jsonc
{ "type": "focus", "payload": { "focused": true } }
```

Gatoway core tracks **at most one** focused connection at a time:

- `focused: true` makes the sending connection the focused one, unconditionally
  superseding whichever connection was previously focused — the previous connection
  does **not** need to send `focused: false` first. This is deliberate: a crashed or
  buggy application that never blurs is resolved by its disconnect, not by requiring
  perfect handshake discipline between every application plugin.
- `focused: false` only has an effect if the sending connection is the one *currently*
  focused; a blur from any other connection is a no-op.
- If the currently-focused connection disconnects (gracefully or unexpectedly), focus
  is cleared to "none" (idle), exactly as if it had sent `focused: false`.

Application plugins should send `focus` promptly on every focus change; there is no
polling or periodic re-assertion — Gatoway core's state is purely event-driven.

Because a disconnect always clears focus, a plugin that reconnects while still
active/focused is **not** automatically treated as focused again on its new connection
— it must re-send `focus: true`. See [Reconnection](#reconnection) below.

## Reconnection

A dropped connection and the fresh connection that replaces it are unrelated as far as
the wire protocol is concerned. Gatoway core assigns every accepted connection its own
new connection ID and keeps no state — declared content, `pluginType`, focus —
beyond that connection's own lifetime; once a connection disconnects, its record is
discarded outright (see [Authentication and registration](#authentication-and-registration)
and [Focus tracking](#focus-tracking) above). There is no session/resume mechanism,
reconnect token, or grace period tied to "the same" logical plugin reconnecting — Gatoway
core has no notion of that at all, only of connections coming and going. Concretely,
this means a plugin author reconnecting (e.g. after a dropped socket, a crash, or a
browser Manifest V3 background service worker being torn down and restarted) must:

- **Send a fresh `register`.** The new connection has no declared content until it
  does — nothing from the prior, now-disconnected connection carries over, even if that
  connection was registered moments earlier. Until `register` is sent, the connection is
  also unauthenticated and cannot send any other message type (it is simply disconnected
  if it tries).
- **Re-send `focus: true` if still active.** Focus is never restored automatically on
  reconnection, because a disconnect always clears focus first — by the time the new
  connection registers, Gatoway core has already forgotten it was ever focused. A plugin
  that is still the foreground/active one when it reconnects must report that
  explicitly; there is no way for Gatoway core to infer it.

No special handshake is needed for either step, precisely because Gatoway core already
tolerates a plugin disconnecting and reconnecting at any time. A plugin doesn't
negotiate resumption or wait out a grace period — it just connects, authenticates, and
sends a fresh `register` (and `focus: true`, if applicable) exactly as it would on its
very first connection. This matters most for a plugin whose connection is expected to
drop and reconnect often — a Manifest V3 browser extension's background service worker
being the prime example — since it means reconnect handling is just "repeat the normal
startup sequence," not separate logic to write and maintain.

## Slot capacity and ordinal content

Gatoway core has no semantic understanding of what any application plugin's buttons or
dials do — only what to display at a given physical slot, and which slot was just
interacted with. Two message types make this possible: the Stream Deck plugin reports
the device's live slot capacity as ordered *position lists* (`device_capacity`); Gatoway
core forwards each application plugin just the *counts* (`slot_capacity`), and resolves
that plugin's ordinally-addressed `content` (see [`register`](#register-plugin--core)
above) against physical positions on its behalf.

### `device_capacity` (Stream Deck plugin → core)

Sent only by the connection that registered as `pluginType: "stream-deck"` — rejected
(logged, ignored) from any other connection. Reports the ordered list of physical
positions currently holding a generic Key action, and the ordered list currently holding
a generic Dial action.

```jsonc
{
  "type": "device_capacity",
  "payload": {
    "buttonPositions": [{ "row": 0, "column": 0 }, { "row": 0, "column": 1 }],
    "dialPositions": [{ "index": 0 }]
  }
}
```

```ts
interface DeviceCapacityPayload {
  buttonPositions: Position[];
  dialPositions: Position[];
}
```

- Sent once at the Stream Deck plugin connection's own registration, and again any time
  the set of placed generic Key/Dial actions changes (an action added/removed, a device
  connected/disconnected) — event-driven, not polled.
- **Order matters and must be stable.** Ordinal index N in `buttonPositions`/
  `dialPositions` is what an application plugin's `content.buttons[N]`/`content.dials[N]`
  ultimately renders at. The Stream Deck plugin is responsible for establishing a
  deterministic order itself (e.g. reading order for keys, ascending index for dials) —
  see `stream-deck-plugin/src/coreClient/deviceCapacity.ts` for the actual rule it uses —
  since the Elgato SDK's own `actions` iterator order is not documented as stable.
- Gatoway core keeps only the **latest** report in memory. It is never persisted and
  never merged with a prior report — a fresh report fully replaces the previous one.

### `slot_capacity` (core → application plugin)

Tells an application plugin how many button/dial slots it currently has to fill — bare
counts only; an application plugin has no use for actual physical positions.

```jsonc
{ "type": "slot_capacity", "connectionId": "abc-123", "payload": { "buttonSlots": 2, "dialSlots": 1 } }
```

```ts
interface SlotCapacityPayload {
  buttonSlots: number;
  dialSlots: number;
}
```

- Sent once immediately after that connection's own successful `register_ack`, and again
  every time Gatoway core records that connection as newly focused (never on blur).
- Derived directly from the Stream Deck plugin's latest `device_capacity` report
  (`buttonSlots = buttonPositions.length`, `dialSlots = dialPositions.length`). If no
  `device_capacity` has ever been received yet (e.g. the Stream Deck plugin isn't
  connected), both counts are `0` — an application plugin declaring content against a
  capacity of zero simply has nothing rendered yet, which is safe, normal behavior.

### How resolution actually works

Gatoway core never needs to know both an ordinal index *and* a physical position for
more than the instant it translates between them:

- **Input → command:** an `input_event`'s reported physical position is looked up in the
  latest `device_capacity` report for the matching controller type, to find its ordinal
  index N. Gatoway core then checks whether the *focused* connection's own
  `content.buttons`/`content.dials` has an entry at index N. If so, that connection
  receives a `command` naming ordinal index N (see [`command`](#command-core--focused-application-connection)
  below). If the position isn't in the latest `device_capacity` report at all, or the
  focused connection's content is shorter than physical capacity (underflow — entirely
  expected, e.g. a plugin with only one button declared on a device with two button
  slots), the event is safely logged and dropped, exactly as an unresolvable event always
  has been.
- **Content → render_update:** the reverse direction, whenever a connection's content is
  newly displayed (it gains focus, or re-registers while already focused). For each
  ordinal index present in that connection's `content.buttons`/`content.dials`, Gatoway
  core looks up the corresponding physical position from the latest `device_capacity`
  report and sends a `render_update` for it. Any remaining physical position, up to full
  device capacity, is swept to the idle appearance — this is what makes a plugin
  declaring *fewer* entries than available slots (underflow) safe: the unused slots
  simply show idle, not stale content from whatever was there before.

An application plugin with more content than it has slots for (or logically grouped
content) manages its own paging/grouping and simply re-`register`s the right-sized subset
to currently show — Gatoway core never needs to know this is happening.

## Position-addressed input and rendering (Stream Deck ↔ core)

These three message types implement Gatoway's generic, position-based action model:
the Stream Deck plugin has no knowledge of *what* a given key or dial means to any
application — it only reports raw physical interactions and displays whatever it is
told to. Gatoway core alone resolves "this position, while this application is
focused" to an ordinal index within that connection's own declared content (see
[Slot capacity and ordinal content](#slot-capacity-and-ordinal-content) above).

### Position addressing

```ts
type Controller = "keypad" | "encoder";
type Position =
  | { row: number; column: number }  // for controller: "keypad"
  | { index: number };                // for controller: "encoder"
```

This matches the Elgato Stream Deck SDK's own addressing exactly (row/column for keys,
a single index for dials — on a Stream Deck+, a dial's SDK "row" is always `0`; its
"column" is the dial's index), so the Stream Deck plugin never needs to translate
coordinates.

### `input_event` (Stream Deck plugin → core)

Reports a raw physical interaction. No app-specific meaning is attached.

```jsonc
{
  "type": "input_event",
  "payload": {
    "controller": "keypad",
    "position": { "row": 0, "column": 1 },
    "eventType": "keyDown"
  }
}
```

```ts
type InputEventType = "keyDown" | "keyUp" | "rotate" | "push";
interface InputEventPayload {
  controller: Controller;
  position: Position;
  eventType: InputEventType;
  delta?: number; // present only when eventType is "rotate"; ticks, +clockwise/-counter-clockwise
}
```

- Keys report both `"keyDown"` and `"keyUp"`.
- Dials report `"rotate"` (with `delta`) for rotation, and a single `"push"` event for
  a dial press. **There is no separate dial-release event** — unlike keys' matched
  down/up pair, a dial press is reported once, on press, as `"push"`.

Gatoway core resolves every `input_event` against **the currently-focused connection's**
own declared content at the reported position (never the sender's — the sender is
always the Stream Deck plugin), via the ordinal-index resolution described in
[How resolution actually works](#how-resolution-actually-works) above. If nothing is
focused, the reported position isn't part of the current device capacity, or the
focused connection's content has no entry at the resolved ordinal index, the event is
silently logged and dropped — this is normal, expected behavior, not an error condition.

### `render_update` (core → Stream Deck plugin)

Instructs the Stream Deck plugin what to display at a given position — including the
built-in idle appearance Gatoway core sends when no connection is focused.

```jsonc
{
  "type": "render_update",
  "connectionId": "<stream-deck connection id>",
  "payload": {
    "controller": "keypad",
    "position": { "row": 0, "column": 1 },
    "label": "Next Photo"
  }
}
```

```ts
interface RenderUpdatePayload {
  controller: Controller;
  position: Position;
  icon?: string | null;
  label?: string;
  state?: number; // keys only — the Elgato SDK has no equivalent concept for dials
}
```

**Fields are sparse.** `icon`/`label`/`state` are all optional, and an update only sets
what is actually changing — an omitted field means "leave whatever was last displayed
there unchanged," not "clear it." The Stream Deck plugin persists the last-known render
state per position indefinitely on its own side, so it continues showing whatever was
last rendered even across a Gatoway core disconnect or restart, until a new
`render_update` arrives.

**`icon` is three-way, not two-way — this distinction matters.** Because JSON
serialization collapses an omitted field and an explicitly-`undefined` field into the
same thing (neither appears on the wire at all), "leave unchanged" and "explicitly clear
this icon" need two different representations:

- **`undefined` / field omitted entirely** — leave whatever icon was last displayed at
  this position unchanged. This is the common case for a partial update (e.g. one that
  only changes `label`).
- **`null`** — explicitly reset the icon to the manifest's bundled default image for
  that position's action (equivalent to calling the Elgato Stream Deck SDK's own
  `setImage()` with no argument). Gatoway core's idle sweep always sends `icon: null`
  for exactly this reason: without a distinct "reset" value, there would be no way to
  actually clear a previously-focused connection's content icon once focus moves
  away from it — omitting `icon` would leave it visually stuck, and inventing a fake
  sentinel string would be worse.
- **a string** — set the icon to this value. See
  [Icon and label content](#icon-and-label-content) below for the required format.

Only the Stream Deck plugin's own connection (`pluginType: "stream-deck"`) ever
receives `render_update` messages.

### Icon and label content

Practical guidance for any `icon`/`label` value sent in `register`'s `content` or
`render_update` — established during live verification of this project against real
Stream Deck+ hardware, plus the canonical pixel-dimension guidance from Elgato's own
Stream Deck SDK schema (`@elgato/schemas`, the source `@elgato/streamdeck`'s manifest
validation is built from):

- **`icon` must be a self-contained image string — never a file path.** Gatoway core's
  Stream Deck plugin bundle cannot contain image assets for applications that don't
  exist at build time (any future application plugin's icons are unknown when the
  Stream Deck plugin is packaged), so `icon` must carry the image data itself: either a
  base64 data URI with a declared MIME type (e.g.
  `data:image/png;base64,iVBORw0KGgo...`) or an inline SVG string. A filesystem path
  would only resolve on the machine and account that produced it, and Gatoway core has
  no mechanism to resolve or transmit a path's file contents on an application's behalf.
- **Size `icon` for a physical key at 72 × 72 px (1x) / 144 × 144 px (2x).** This is the
  same pixel size Elgato's own Stream Deck SDK documents for a manifest action's default
  key image (`@elgato/schemas`' `States[].Image` schema entry: "Provided in two sizes,
  72 × 72 px and 144 × 144 px (@2x)") — Gatoway core doesn't resize or scale whatever
  `icon` a plugin sends, so match this size (or supply an SVG, which scales cleanly at
  any size) to avoid a blurry or cropped result. GIF, PNG, and SVG are all supported
  formats per that same schema.
- **Keep `label` short — roughly 8-10 characters at the Stream Deck's default font
  size.** The physical key's title area clips or overflows past that, rather than
  wrapping or shrinking to fit. Confirmed live on real Stream Deck+ hardware: a
  7-character label (`"Gatoway"`, the built-in idle label) displays fully, while a
  19-character label visibly overflows the key's title area. Prefer a short label; there
  is no separate description/tooltip field to fall back on for extra context (the old
  `Capability.description` field carried no rendering behavior and was removed as
  unused — see `extension-provided-slot-content` design.md D3).

### `command` (core → focused application connection)

Sent to the currently-focused application connection once an `input_event` has been
successfully resolved against an ordinal index within that connection's own declared
content.

```jsonc
{
  "type": "command",
  "connectionId": "<focused connection id>",
  "payload": {
    "controller": "keypad",
    "slotIndex": 0,
    "eventType": "keyDown"
    // "delta" is present only when the originating input_event was a "rotate"
  }
}
```

```ts
interface CommandPayload {
  controller: Controller;
  slotIndex: number;    // ordinal position within this connection's own content.buttons/content.dials
  eventType: InputEventType;
  delta?: number;         // carried through from the originating input_event, if present
}
```

`slotIndex` identifies the entry's position within the focused connection's own
`content.buttons` (`controller: "keypad"`) or `content.dials` (`controller: "encoder"`)
array, exactly as last declared via `register` — Gatoway core carries no other meaning
for it, and there is no id to translate it back to; the application plugin itself
already knows what it put at that index.

**Gesture timing is the receiving plugin's responsibility, not Gatoway's.** Neither
Gatoway core nor the Stream Deck plugin does any debouncing or timing analysis — a
`keyDown`/`keyUp` pair is forwarded as two separate `command` messages exactly as
reported, and `CommandPayload` doesn't even carry a timestamp. This is deliberate, per
AD-8: the Stream Deck plugin has zero app-specific knowledge, and Gatoway core's job
stops at resolving position → ordinal index, never gesture semantics. So double-press
detection, long-press detection, or distinguishing a quick tap from a held key is
entirely up to the application plugin receiving the `command` messages — it must track
its own event timestamps per `controller`/`slotIndex` pair across successive messages it
receives. Gatoway does not, and will not, provide this itself.

> **Implementation note:** this message type is not part of any design document's
> original enumerated set of new message types for the change that introduced it
> (`focus-profile-routing`'s design.md originally listed only `focus`, `input_event`,
> `render_update`) — it was added as a minimal, necessary fill of a gap discovered
> during implementation. It follows the same envelope and framing as every other
> message type.

## Live content updates: re-send `register`

There is no separate "update" message for a live display change (a photo counter
ticking up, a toggle state flipping, paging to a different subset of content, entering
or leaving a nested group). A plugin simply re-sends `register` with its complete,
current `content` — the same mechanism used at initial registration (see
[`register`](#register-plugin--core) above: "Sending `register` again … re-declares its
content"). This was a deliberate protocol-simplicity trade-off: always resending the
full `content` array costs more bytes than a lightweight single-slot update would for a
small change, in exchange for a single, uniform update mechanism instead of two.

**Rendered immediately if relevant.** If the sending connection currently has focus,
Gatoway core immediately re-derives and sends the Stream Deck plugin fresh
`render_update`s for every position that changed, exactly as a focus change does. If the
sending connection isn't currently focused, the new content is simply stored for next
time that connection gains focus — nothing is rendered right away.

## Example: a full focus/input/render/update cycle

1. An application plugin connects, authenticates, and sends `register` declaring
   `content.buttons: [{ "label": "Next Photo" }]`.
2. Gatoway core sends it `slot_capacity` reflecting the Stream Deck plugin's current
   device capacity.
3. It sends `focus: { focused: true }` when its window becomes active.
4. Gatoway core sends the Stream Deck plugin a `render_update` for the physical position
   corresponding to ordinal index 0 in the latest `device_capacity` report (e.g.
   `{ label: "Next Photo" }` at row 0, column 1), plus a fresh `slot_capacity` to the
   now-focused connection.
5. The user presses that physical key. The Stream Deck plugin sends
   `input_event: { controller: "keypad", position: { row: 0, column: 1 }, eventType:
   "keyDown" }`.
6. Gatoway core resolves that position to ordinal index 0 via the latest
   `device_capacity` report, finds an entry at that index in the focused connection's
   `content.buttons`, and sends that connection
   `command: { controller: "keypad", slotIndex: 0, eventType: "keyDown" }`.
7. The application plugin acts on it (e.g. advances to the next photo), and re-sends
   `register` with `content.buttons: [{ "label": "Next Photo (4/24)" }]` to reflect the
   new position in its own photo sequence. Since this connection is still focused,
   Gatoway core immediately sends the Stream Deck plugin a fresh `render_update` for that
   same position with the updated label — no further key press or focus change needed.
8. When the application loses focus (or disconnects), Gatoway core sends the Stream
   Deck plugin a fresh `render_update` sweep, spanning every position in the latest
   `device_capacity` report, reflecting the built-in idle appearance (`icon: null`,
   explicitly resetting any icon the previous content displayed).
