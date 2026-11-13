// The plugin's `$.state` contract: what it keeps for the session, under its own name.

/** Who the session is, as Claude Code's telemetry rows say. Each field is absent until a row carries a value that fits its shape. */
export type RowIdentity = {
  /** `organization.id`: the Claude organization. */
  organizationId?: string
  /** `user.account_uuid`: the Claude account. */
  accountUuid?: string
  /** `user.email`: the account's email. */
  email?: string
  /** `user.id`: the ID Claude Code keeps per installation (the device). */
  deviceId?: string
}

declare module 'claude-code' {
  interface PluginState {
    mainwave: {
      identity: RowIdentity
      /** Whether this process has counted its session in `claude_code.session.count`: once, whatever reloads the plugin. */
      sessionCounted: boolean
    }
  }
}
