// Paseo notifies only when an agent's unread flag goes from off to on. The turn that hit the
// limit already set that flag, and it stays set until someone opens the agent. A resumed turn
// that finishes while the flag is still set would therefore finish silently.
//
// The plugin API has no call to clear the flag, so this sends the same request the app sends
// when an agent is opened, over the plugin's existing daemon connection. Without a requestId
// the daemon sends no response, so the plugin's own client never sees a stray reply.

type SendToDaemon = (message: unknown) => void;

export function clearAttentionFrame(agentId: string): string {
  return JSON.stringify({ type: "session", message: { type: "clear_agent_attention", agentId } });
}

/** Returns false when there is no daemon connection to send over. */
export function clearAttention(
  agentId: string,
  send: SendToDaemon | undefined = process.send?.bind(process),
): boolean {
  if (!send) return false;
  send({ type: "paseo_frame", data: clearAttentionFrame(agentId), isBinary: false });
  return true;
}
