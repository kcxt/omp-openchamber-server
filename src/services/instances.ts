/** Process-lifetime runtimes shared by route modules and the startup/shutdown code. */
import { join } from "node:path";
import { createMessageQueueRuntime } from "../adapters/openchamber/message-queue";
import { BrowserControlBroker } from "../panels/browser-control";
import { createProjectContextRuntime } from "../panels/project-context";
import { createTerminalRuntime } from "../panels/terminal";
import { emitBrowserControlRequest } from "../shared/sse";
import { openChamberDataDir } from "./settings-file";

export const messageQueueRuntime = createMessageQueueRuntime();

export const terminalRuntime = createTerminalRuntime();

export const browserControlBroker = new BrowserControlBroker({
  emitRequest: emitBrowserControlRequest,
});

export const projectContextRuntime = createProjectContextRuntime({
  projectsDirPath: join(openChamberDataDir, "projects"),
});
