/**
 * The ordered route table. First handler to answer wins, so order is
 * behaviour: modules whose matchers are broad (prefix tests, `p.startsWith`)
 * must stay behind the modules whose exact routes they would otherwise shadow.
 */
import type { RouteHandler } from "../http/router";
import { handleConfig } from "./config";
import { handleEvents } from "./events";
import { handleFs } from "./fs";
import { handleGit } from "./git";
import { handleGoals } from "./goals";
import { handleInteractions } from "./interactions";
import { handleOmpSettings } from "./omp-settings";
import { handlePlatform } from "./platform";
import { handleProviders } from "./providers";
import { handleRevert } from "./revert";
import { handleSessions } from "./sessions";
import { handleTerminal } from "./terminal";
import { handleTranscript } from "./transcript";
import { handleTurns } from "./turns";

export const routeTable: readonly RouteHandler[] = [
  handlePlatform,
  handleFs,
  handleGit,
  handleConfig,
  handleOmpSettings,
  handleEvents,
  handleInteractions,
  handleSessions,
  handleGoals,
  handleRevert,
  handleTurns,
  handleTranscript,
  handleProviders,
  handleTerminal,
];
