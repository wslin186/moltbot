import type { MoltbotPluginApi } from "clawdbot/plugin-sdk";

import { createPolymarketTool } from "./src/polymarket-tool.js";

const polymarketPlugin = {
  id: "polymarket",
  name: "Polymarket",
  description: "Polymarket CLOB trading tool (market lookup + order placement with approvals).",
  register(api: MoltbotPluginApi) {
    api.registerTool((ctx) => {
      // Allow read-only usage in sandboxed contexts, but block order placement.
      return createPolymarketTool({ api, ctx });
    });
  },
};

export default polymarketPlugin;

