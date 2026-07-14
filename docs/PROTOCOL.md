# Gatoway Message Protocol Reference

**Status: draft**, produced by the `focus-profile-routing` change (tasks.md 5.1/5.2).
This is a first-pass reference covering the full message contract implemented as of
that change; final polish and placement are owned by the `doc-writer` role. If you are
writing a new application plugin (following Lightroom or xDesign), this document
should be the only thing you need to read to speak Gatoway's wire protocol — you should
not need to read Gatoway core's source.

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
  is ignored if present) on this transport.
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
}
```

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
  icon?: string;
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

Only the Stream Deck plugin's own connection (`pluginType: "stream-deck"`) ever
receives `render_update` messages.

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

## Example: a full focus/input/render cycle

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
6. The application plugin acts on it (e.g. advances to the next photo).
7. When the application loses focus (or disconnects), Gatoway core sends the Stream
   Deck plugin a fresh `render_update` sweep reflecting the built-in idle appearance.
