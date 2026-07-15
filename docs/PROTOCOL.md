# Gatoway Message Protocol Reference

Covers the full message contract implemented as of the `focus-profile-routing` change,
including its task-group-7 addendum (`capability_update` and the `render_update`/
`capability_update` icon reset semantics). If you are writing a new application plugin
(following Lightroom or xDesign), this document should be the only thing you need to
read to speak Gatoway's wire protocol — you should not need to read Gatoway core's
source. Kept in sync with `gatoway-core/src/protocol/messages.ts`, the single source of
truth for these shapes; if the two ever disagree, the source wins and this document is
stale.

Speaking the wire protocol correctly is necessary but not sufficient to see anything
render: a capability also needs a physical position bound to it in the local layout
config file, which is a separate, host-side concern from anything on this wire — see
[`LAYOUT_CONFIG.md`](LAYOUT_CONFIG.md) for that file's schema, location, and a worked
example.

## Transport and framing

Gatoway core exposes two listeners, both bound to IPv4 loopback (`127.0.0.1`) only:

- **TCP**, newline-delimited JSON ("NDJSON"): one JSON object per line, each line
  terminated by `\n`. Used by native (non-browser) plugins, e.g. the Lightroom Lua
  plugin and the Stream Deck plugin itself.
- **WebSocket**: one JSON object per WebSocket text frame (no NDJSON framing — the
  frame boundary *is* the message boundary). Used by browser-based plugins, e.g. the
  xDender browser extension.

Message-handling logic is identical across both transports — only the connection-accept
and authentication code differs (see [Authentication](#authentication) below).

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
capability manifest.

```jsonc
{
  "type": "register",
  "payload": {
    "pluginType": "lightroom",       // string, required: identifies the kind of plugin
    "capabilities": [                // Capability[], required (may be empty)
      { "id": "next-photo", "label": "Next Photo", "type": "button" }
    ],
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
- Sending `register` again on an already-authenticated connection re-declares its
  capability manifest without repeating the credential check. Omitting `capabilities`
  on a re-registration leaves the previously-declared manifest unchanged; an explicit
  array (including `[]`) always replaces it.
- `pluginType` is a free-form string identifying the *kind* of plugin (e.g.
  `"lightroom"`, `"xdesign"`, `"stream-deck"` — the last one reserved for the Stream
  Deck plugin itself, which is the only connection Gatoway core ever sends
  `render_update` to). It is never used as, or derived from, the connection's unique
  ID — multiple simultaneous connections may share the same `pluginType`.

#### `Capability`

```ts
interface Capability {
  id: string;               // stable identifier, referenced later in `command` messages
  label: string;             // human-readable name
  type: "button" | "dial";
  description?: string;
  icon?: string;
  state?: number;            // toggle/indicator state, e.g. on/off
}
```

`icon` here is a plain optional string, not the `string | null | undefined` three-way
distinction `render_update`/`capability_update` use on the wire (see below) — on this
stored, in-memory record, `undefined` covers both "never declared an icon" and
"explicitly reset via a later `capability_update`"; both are the same fact ("this
capability currently has no icon") from a plugin author's point of view. See
[Icon and label content](#icon-and-label-content) for format and length guidance that
applies to `icon`/`label` everywhere they appear in the protocol — at registration, in
`render_update`, and in `capability_update`.

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
simply disconnected instead, with no `error` sent first.

```jsonc
{
  "type": "error",
  "connectionId": "abc-123",
  "payload": { "message": "malformed message: …", "details": { } }
}
```

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

## Position-addressed input and rendering (Stream Deck ↔ core)

These three message types implement Gatoway's generic, position-based action model:
the Stream Deck plugin has no knowledge of *what* a given key or dial means to any
application — it only reports raw physical interactions and displays whatever it is
told to. Gatoway core alone resolves "this position, while this application is
focused" to a specific capability.

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
bound capability at the reported position (never the sender's — the sender is always
the Stream Deck plugin). If nothing is focused, or the focused connection has no
capability bound at that position, the event is silently logged and dropped — this is
normal, expected behavior, not an error condition.

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
  actually clear a previously-focused connection's capability icon once focus moves
  away from it — omitting `icon` would leave it visually stuck, and inventing a fake
  sentinel string would be worse.
- **a string** — set the icon to this value. See
  [Icon and label content](#icon-and-label-content) below for the required format.

Only the Stream Deck plugin's own connection (`pluginType: "stream-deck"`) ever
receives `render_update` messages.

### Icon and label content

Practical guidance for any `icon`/`label` value sent in `register`'s `capabilities`,
`render_update`, or `capability_update` — established during live verification of this
change against real Stream Deck+ hardware:

- **`icon` must be a self-contained image string — never a file path.** Gatoway core's
  Stream Deck plugin bundle cannot contain image assets for applications that don't
  exist at build time (any future application plugin's icons are unknown when the
  Stream Deck plugin is packaged), so `icon` must carry the image data itself: either a
  base64 data URI with a declared MIME type (e.g.
  `data:image/png;base64,iVBORw0KGgo...`) or an inline SVG string. A filesystem path
  would only resolve on the machine and account that produced it, and Gatoway core has
  no mechanism to resolve or transmit a path's file contents on an application's behalf.
- **Keep `label` short — roughly 8-10 characters at the Stream Deck's default font
  size.** The physical key's title area clips or overflows past that, rather than
  wrapping or shrinking to fit. Confirmed live on real Stream Deck+ hardware during this
  change's verification: a 7-character label (`"Gatoway"`, the built-in idle label)
  displays fully, while a 19-character label (`"Fixture A (pushed)"`, sent by the manual
  test-app client's `update` command) visibly overflows the key's title area. Prefer a
  short label plus, if more context is needed, the `description` field declared at
  registration (not currently rendered on the physical device, but available for a
  future Property Inspector or tooltip use).

### `command` (core → focused application connection)

Sent to the currently-focused application connection once an `input_event` has been
successfully resolved against one of its declared capabilities.

```jsonc
{
  "type": "command",
  "connectionId": "<focused connection id>",
  "payload": {
    "capabilityId": "next-photo",
    "eventType": "keyDown"
    // "delta" is present only when the originating input_event was a "rotate"
  }
}
```

```ts
interface CommandPayload {
  capabilityId: string;   // matches a `Capability.id` this connection declared at registration
  eventType: InputEventType;
  delta?: number;         // carried through from the originating input_event, if present
}
```

> **Implementation note:** this message type is not part of the original design
> document's enumerated set of new message types for this change (`focus`,
> `input_event`, `render_update`) — it was added as a minimal, necessary fill of a gap
> discovered during implementation (the design's own `profile-routing` requirements
> describe Gatoway core "forwarding a corresponding command" to the focused connection,
> but never define that message's shape). It follows the same envelope and framing as
> every other message type. See the `focus-profile-routing` change's developer report
> for the full note; a future architecture pass may want to formally ratify this shape.

### `capability_update` (application plugin → core)

Lets a plugin push a live display change to one of its own already-declared
capabilities, at any time after registration — not just at registration time. This is
the mechanism that satisfies `REQUIREMENTS.md` FR-001's "an application can push a state
update that changes a button's icon, label, or toggle state."

```jsonc
{
  "type": "capability_update",
  "payload": {
    "capabilityId": "next-photo",
    "label": "Next Photo (3/24)"
  }
}
```

```ts
interface CapabilityUpdatePayload {
  capabilityId: string;
  icon?: string | null;
  label?: string;
  state?: number;
}
```

- **Fields other than `capabilityId` are sparse**, using the same
  unchanged-if-omitted / explicit-`null`-resets-icon semantics as `render_update`'s
  `icon` field (see [Icon and label content](#icon-and-label-content) above for format
  and length guidance — it applies here too).
- **A plugin may only update capabilities it has itself declared.** Gatoway core looks
  `capabilityId` up within the *sending connection's own* registered capabilities only;
  an id that isn't among them is ignored (logged, not an error) — a plugin can never
  reach into another connection's capabilities this way.
- **No acknowledgement message.**
- **Rendered immediately if relevant.** If the sending connection currently has focus
  and the updated capability is bound to a position in its layout, Gatoway core
  immediately sends the Stream Deck plugin a fresh `render_update` reflecting the
  change — an application doesn't have to wait for the user to press something, or for
  a focus change, to see its own pushed update take effect. If the sending connection
  isn't currently focused, the update is still stored (so it's reflected next time that
  connection gains focus), but nothing is rendered right away.

## Example: a full focus/input/render/update cycle

1. An application plugin connects, authenticates, and sends `register` declaring a
   `next-photo` button capability.
2. It sends `focus: { focused: true }` when its window becomes active.
3. Gatoway core sends the Stream Deck plugin a `render_update` for every position bound
   in that application's layout (e.g. `{ label: "Next Photo" }` at row 0, column 1).
4. The user presses that physical key. The Stream Deck plugin sends
   `input_event: { controller: "keypad", position: { row: 0, column: 1 }, eventType:
   "keyDown" }`.
5. Gatoway core resolves that position against the focused connection's layout,
   finds the `next-photo` capability, and sends that connection
   `command: { capabilityId: "next-photo", eventType: "keyDown" }`.
6. The application plugin acts on it (e.g. advances to the next photo), and pushes
   `capability_update: { capabilityId: "next-photo", label: "Next Photo (4/24)" }` to
   reflect the new position in its own photo sequence. Since this connection is still
   focused and `next-photo` is still bound at row 0, column 1, Gatoway core immediately
   sends the Stream Deck plugin a fresh `render_update` for that position with the
   updated label — no further key press or focus change needed.
7. When the application loses focus (or disconnects), Gatoway core sends the Stream
   Deck plugin a fresh `render_update` sweep reflecting the built-in idle appearance
   (`icon: null`, explicitly resetting any icon the previous capability displayed).
