/**
 * Payload shapes for the message types defined by this change: `register`,
 * `register_ack`, and `error`. Command and state-update message types belong to a
 * later change, once a Stream Deck plugin and at least one app plugin exist to use
 * them (see design.md D4 and proposal.md's "Out of scope" section).
 */

/** A single capability (button or dial action) a plugin declares at registration. */
export interface Capability {
  id: string;
  label: string;
  type: "button" | "dial";
  description?: string;
  icon?: string;
}

/**
 * Sent by a plugin to authenticate and declare its capability manifest.
 *
 * `token` is required for TCP (native) connections and validated against the current
 * auth token file. WebSocket (browser) connections authenticate via the `Origin`
 * header at the HTTP-upgrade stage (see design.md D5) and do not need to supply a
 * token here, so the field is optional in the shared shape.
 */
export interface RegisterPayload {
  pluginType: string;
  capabilities: Capability[];
  token?: string;
}

export type RegisterAckStatus = "ok" | "rejected";

/** Sent by Gatoway core in response to a `register` message. */
export interface RegisterAckPayload {
  status: RegisterAckStatus;
  connectionId: string;
  reason?: string;
}

/** Usable by either Gatoway core or a connected plugin to report a protocol-level error. */
export interface ErrorPayload {
  message: string;
  details?: unknown;
}
