export function sendDiagnosticReply(
  channel: Pick<NodeJS.Process, "connected" | "send">,
  message: Record<string, unknown>,
): void {
  if (!channel.connected || !channel.send) return;
  channel.send(message, () => {
    // Best-effort diagnostic: consume a channel-close race after the connected check.
  });
}
