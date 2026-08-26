import { Command } from "commander";
import { getDaemonUrl } from "../lib/config";
import { ensureDaemon } from "./shared";
import { sessionRoute } from "../lib/session-route";

export function createDismissCommand(): Command {
  return new Command("dismiss")
    .description("Dismiss/remove a session")
    .argument("<session-id>", "Session ID or pane ID to dismiss")
    .action(async (sessionId: string) => {
      await ensureDaemon();

      try {
        const response = await fetch(
          `${getDaemonUrl()}${sessionRoute(sessionId)}`,
          {
            method: "DELETE",
          },
        );

        if (response.status === 404) {
          console.error(`Session not found: ${sessionId}`);
          process.exit(1);
        }

        if (!response.ok) {
          throw new Error(`HTTP ${response.status}`);
        }

        console.log(`Session dismissed: ${sessionId}`);
      } catch (error) {
        console.error("Failed to dismiss session:", error);
        process.exit(1);
      }
    });
}
