# Gatoway Layout Config Reference

Covers the layout config file introduced by `persisted-layout-config`: the local,
hand-authored JSON file that binds physical Stream Deck positions to application
capability ids. This is the mechanism a real application plugin (Lightroom, xDesign, or
anything else speaking [`docs/PROTOCOL.md`](PROTOCOL.md)) actually needs, in addition to
the wire protocol itself, to get its declared capabilities to appear on a physical key or
dial — without a binding, a capability a plugin registers is never rendered anywhere,
even while that plugin has focus. Kept in sync with
`gatoway-core/src/routing/layoutConfig.ts` (the schema/validation source of truth) and
`gatoway-core/src/routing/layoutStore.ts` (load/save behavior); if the two ever disagree,
the source wins and this document is stale.

This is a **local, per-machine config file**, not part of the wire protocol — it is read
once by Gatoway core at its own startup, not exchanged with any plugin over TCP or
WebSocket.

## File location

| | |
|---|---|
| Default path | `<config dir>/layout.json`, in the same per-OS user config directory as the auth token file (see [`gatoway-core/README.md`](../gatoway-core/README.md#configuration-environment-variables)) |
| Override | `GATOWAY_LAYOUT_FILE` environment variable — an absolute path to the file, replacing the default entirely |

Per-OS default config directory (absent `GATOWAY_CONFIG_DIR`/`GATOWAY_LAYOUT_FILE`):

- macOS: `~/Library/Application Support/gatoway/layout.json`
- Windows: `%APPDATA%\gatoway\layout.json`
- Linux/other: `$XDG_CONFIG_HOME/gatoway/layout.json` or `~/.config/gatoway/layout.json`

The file is **read once, at Gatoway core startup only** — there is no hot-reload.
Editing it while Gatoway core is already running has no effect until Gatoway core is
restarted (a deliberate scope limitation of `persisted-layout-config`, matching how
every other piece of startup configuration already works).

## When Gatoway core reads it

On every `startGatowayCore()` invocation, Gatoway core loads the layout config file
exactly once, before either listener starts accepting connections. What happens next
depends on what's found at the configured path — see
[Missing or malformed file](#missing-or-malformed-file) below. This never crashes
Gatoway core: worst case, it starts with an empty layout (every position unbound) and
logs why.

## JSON schema

```jsonc
{
  "profiles": {
    "<pluginType>": {
      "bindings": [
        { "controller": "keypad", "position": { "row": 0, "column": 0 }, "capabilityId": "<capability id>" },
        { "controller": "encoder", "position": { "index": 0 }, "capabilityId": "<capability id>" }
      ]
    }
  }
}
```

- **`profiles`** — required object, keyed by **plugin type** (the same free-form string
  a plugin declares in its `register` message's `pluginType` field — see
  [`PROTOCOL.md`'s `register`](PROTOCOL.md#register-plugin--core), e.g. `"lightroom"`,
  `"xdesign"`). Plugin type is used as the key — not connection id — because it is the
  stable identity across reconnects; a connection id is regenerated every time a plugin
  reconnects, so it cannot anchor persisted data.
- **`bindings`** — required array (may be empty) of binding objects for that plugin type.
  Each binding is:
  - **`controller`** — `"keypad"` or `"encoder"`, matching
    [`PROTOCOL.md`'s `Controller`](PROTOCOL.md#position-addressing) type.
  - **`position`** — `{ "row": number, "column": number }` for a `"keypad"` controller,
    or `{ "index": number }` for an `"encoder"` controller. The shape must match its
    controller — a keypad binding with an `index` field (or vice versa) is rejected as
    malformed.
  - **`capabilityId`** — non-empty string, matching the `id` of a capability the
    corresponding plugin declares in its own `register` message
    (see [`PROTOCOL.md`'s `Capability`](PROTOCOL.md#capability)). Gatoway core does not
    validate this against any plugin's actual manifest at load time — an unmatched or
    misspelled id simply never resolves to anything (silently, like any other unbound
    position), so double-check it against the exact id the target plugin registers.

Everything at every level is validated on load: an unrecognized `controller` value, a
`position` shape that doesn't match its `controller`, or a missing/empty `capabilityId`
all cause the whole file to be rejected as malformed (see below) — there is no
partial/best-effort load of a file with some valid and some invalid bindings.

## Missing or malformed file

Gatoway core never fails to start because of this file. Three cases, all logged clearly
to the rotating log file (see `gatoway-core/README.md`'s Logging section), all falling
back to an **empty layout** (every position unbound, as if no plugin had ever registered
a binding):

| Case | Behavior | Log event |
|---|---|---|
| No file exists at the configured path | Starts normally with zero bindings | `layout_config_missing` — states the expected path |
| File exists but isn't valid JSON | Starts normally with zero bindings | `layout_config_invalid_json` — includes the parse error |
| File is valid JSON but doesn't match the schema above (e.g. `profiles` isn't an object, a binding is missing a field, a position shape doesn't match its controller) | Starts normally with zero bindings | `layout_config_invalid_shape` — includes the specific validation failure (which field, which profile/binding index) |
| File is valid and matches the schema | Loads normally | `layout_config_loaded` — includes the number of profiles loaded |

A fresh install (no file yet) and a broken file behave identically from a running
Gatoway core's point of view: zero bindings, nothing rendered anywhere until either the
file is created/fixed and Gatoway core is restarted. This is intentional (see
`openspec/changes/persisted-layout-config/design.md` D4) — a personal-use background
service that degrades to "does nothing yet" is a better failure mode than one that
refuses to start at all.

## Worked example

A `lightroom` plugin declares two capabilities at registration — a `next-photo` button
and an `exposure` dial — and wants `next-photo` on the top-left key and `exposure` on the
first dial:

```json
{
  "profiles": {
    "lightroom": {
      "bindings": [
        {
          "controller": "keypad",
          "position": { "row": 0, "column": 0 },
          "capabilityId": "next-photo"
        },
        {
          "controller": "encoder",
          "position": { "index": 0 },
          "capabilityId": "exposure"
        }
      ]
    }
  }
}
```

To use it:

1. Save this as the file at the default path for your OS (or wherever
   `GATOWAY_LAYOUT_FILE` points), e.g. on macOS:
   `~/Library/Application Support/gatoway/layout.json`.
2. Start (or restart) Gatoway core — remember, the file is only read at startup.
3. Confirm it loaded: check the log for a `layout_config_loaded` entry
   (`profileCount: 1`), not `layout_config_missing`/`layout_config_invalid_*`.
4. Once the `lightroom` plugin connects, registers `next-photo`/`exposure` among its
   capabilities, and reports focus, the Stream Deck should show `next-photo`'s
   label/icon on keypad `{row: 0, column: 0}` and `exposure`'s on encoder `{index: 0}`.

A layout config can hold multiple `profiles` entries at once (one per plugin type); every
bound position across *every* profile — not just the currently-focused one — is reset to
the idle appearance whenever focus clears, so an unfocused profile's positions never get
left showing stale content.

While developing or testing without a real application plugin, the manual test-app
client (`gatoway-core/test/manual/testAppClient.ts`) registers under `pluginType:
"test-app"` and documents, in its own header comment, the exact layout config snippet
needed to see its fixture capabilities rendered — see
[`gatoway-core/README.md`'s Manual test clients section](../gatoway-core/README.md#manual-test-clients).

## Writing the file programmatically (`LayoutStore`)

`gatoway-core`'s `LayoutStore` class (exported from `@gatoway/core`) provides
`setBinding()`/`removeBinding()`/`save()` in addition to the read path Gatoway core
itself uses at startup. **Nothing in Gatoway core calls these yet** — they exist as the
API surface a future no-code mapping UI (post-MVP, undesigned) will need, not as a
currently-supported way to edit the file. For now, hand-editing the JSON directly (per
the schema above) is the only supported workflow. `save()` writes atomically (temp file +
rename) so an interrupted save can never corrupt the file Gatoway core will read on its
next startup.

## Known limitations

- **No schema versioning or migration tooling.** A future change to this file's shape
  would require hand-editing existing files; see `ARCHITECTURE.md`'s Risk R-3.
- **No hot-reload.** Changes to the file take effect only on Gatoway core's next
  startup.
- **No validation against a plugin's actual declared capabilities.** An unmatched
  `capabilityId` is not an error — it behaves exactly like any other unbound position
  (silently ignored).
