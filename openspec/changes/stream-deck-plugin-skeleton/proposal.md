## Why

`ARCHITECTURE.md`'s delivery sequence step 2 is the Stream Deck plugin skeleton: nothing
can exercise the Gatoway core foundation built in `gatoway-core-foundation` end to end
until something actually spawns it, connects to it, and shows something on the physical
Stream Deck hardware. This is also the prerequisite for step 3 (adapting the Lightroom
plugin), since that step needs a running Stream Deck plugin to validate against.

## What Changes

- Introduce a new Stream Deck plugin (Node.js/TypeScript, built on the Elgato Stream Deck
  SDK) that:
  - Spawns Gatoway core as a child process on the plugin's own startup, and supervises it
    — restarting it if it exits unexpectedly (AD-1).
  - Connects to the running Gatoway core as a client over its existing TCP protocol,
    presenting the shared-secret token exactly as any other native plugin would
    (`plugin-authentication`, `message-protocol` — no protocol changes needed).
  - Renders a single, static idle profile on the physical Stream Deck hardware via the
    Elgato Stream Deck SDK once connected.
- Out of scope for this change (deferred to later delivery-sequence steps once there's an
  application plugin and focus/profile logic to drive them):
  - Forwarding physical button presses or dial turns anywhere — there is no `command`
    message type yet and no application connected to route them to.
  - Any profile switching, focus tracking, or the idle-vs-app-profile distinction beyond
    always showing the one static idle profile.
  - Any application-specific plugin work (Lightroom, xDesign).

## Capabilities

### New Capabilities
- `stream-deck-core-lifecycle`: the Stream Deck plugin spawning Gatoway core as a child process on startup and supervising it, restarting it if it exits unexpectedly.
- `stream-deck-core-client`: the Stream Deck plugin connecting to Gatoway core as an authenticated TCP client, registering, and reconnecting with retry/backoff if the connection drops.
- `stream-deck-idle-display`: rendering a single static idle profile on the physical Stream Deck hardware via the Elgato Stream Deck SDK once connected to Gatoway core.

### Modified Capabilities
None. This change is a new consumer of the existing `connection-management`,
`plugin-authentication`, and `message-protocol` capabilities from `gatoway-core-foundation`
— it uses their existing contract (TCP + token handshake + `register`/`register_ack`) as-is
and does not change any of their requirements.

## Impact

- New Node.js/TypeScript codebase for the Stream Deck plugin; depends on the Elgato Stream
  Deck SDK (new external dependency) and on the already-built `gatoway-core` package (as a
  dependency or sibling package, per design.md).
- No changes to `gatoway-core`'s code or specs.
- Establishes the first real, physical-hardware-visible milestone: after this change, a
  developer can plug in a Stream Deck, launch this plugin, and see Gatoway core come up and
  an idle profile appear — the first end-to-end proof the foundation actually works outside
  of tests.
