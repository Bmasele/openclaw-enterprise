import type { CDPSession, Page } from "playwright-core";
import { emitAgentEvent } from "../infra/agent-events.js";

/**
 * Singleton managing CDP Page.screencast lifecycle.
 * Streams JPEG frames as agent events for real-time browser preview.
 */
class ScreencastManager {
  private cdpSession: CDPSession | null = null;
  private starting = false;
  private runId: string | null = null;
  private sessionKey: string | undefined;

  async start(page: Page, runId: string, sessionKey?: string): Promise<void> {
    if (this.cdpSession || this.starting) {
      return;
    }
    this.starting = true;
    this.runId = runId;
    this.sessionKey = sessionKey;

    try {
      const session = await page.context().newCDPSession(page);
      this.cdpSession = session;

      session.on("Page.screencastFrame", (params: { data: string; metadata: unknown; sessionId: number }) => {
        if (this.runId) {
          emitAgentEvent({
            runId: this.runId,
            sessionKey: this.sessionKey,
            stream: "screencast",
            data: { frame: params.data },
          });
        }
        // Ack the frame so CDP sends the next one (built-in backpressure)
        session.send("Page.screencastFrameAck", { sessionId: params.sessionId }).catch(() => {});
      });

      await session.send("Page.startScreencast", {
        format: "jpeg",
        quality: 40,
        maxWidth: 1280,
        maxHeight: 720,
      });

      this.starting = false;

      // Emit start control event
      emitAgentEvent({
        runId,
        sessionKey,
        stream: "screencast",
        data: { phase: "start" },
      });
    } catch {
      this.cdpSession = null;
      this.starting = false;
      this.runId = null;
      this.sessionKey = undefined;
      // Silently fail — screencast is best-effort
    }
  }

  async stop(): Promise<void> {
    const session = this.cdpSession;
    const runId = this.runId;
    const sessionKey = this.sessionKey;

    this.cdpSession = null;
    this.starting = false;
    this.runId = null;
    this.sessionKey = undefined;

    if (!session) {
      return;
    }

    try {
      await session.send("Page.stopScreencast");
    } catch {
      // Session may already be detached
    }
    try {
      await session.detach();
    } catch {
      // Ignore detach errors
    }

    if (runId) {
      emitAgentEvent({
        runId,
        sessionKey,
        stream: "screencast",
        data: { phase: "stop" },
      });
    }
  }

  isActive(): boolean {
    return this.cdpSession !== null || this.starting;
  }
}

export const screencastManager = new ScreencastManager();
