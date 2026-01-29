import { describe, expect, it, vi } from "vitest";

import { createPolymarketTool } from "./polymarket-tool.js";

function createApi(overrides?: { pluginConfig?: Record<string, unknown> }) {
  return {
    id: "polymarket",
    name: "Polymarket",
    source: "test",
    config: {},
    pluginConfig: overrides?.pluginConfig ?? {},
    runtime: {} as never,
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    },
    registerTool: vi.fn(),
    registerHook: vi.fn(),
    registerHttpHandler: vi.fn(),
    registerHttpRoute: vi.fn(),
    registerChannel: vi.fn(),
    registerGatewayMethod: vi.fn(),
    registerCli: vi.fn(),
    registerService: vi.fn(),
    registerProvider: vi.fn(),
    registerCommand: vi.fn(),
    resolvePath: (p: string) => p,
    on: vi.fn(),
  } as never;
}

describe("polymarket tool", () => {
  it("status reports missing private key", async () => {
    const api = createApi({
      pluginConfig: { tradeEnabled: true, privateKeyEnvVar: "POLYMARKET_PRIVATE_KEY" },
    });
    delete process.env.POLYMARKET_PRIVATE_KEY;

    const tool = createPolymarketTool({
      api,
      ctx: { sandboxed: false, sessionKey: "sess" },
    });

    const result = await tool.execute("call", { action: "status" });
    expect(result.details).toMatchObject({
      ok: true,
      status: "ok",
      config: expect.objectContaining({ privateKeyPresent: false }),
    });
  });

  it("blocks place_order when trading is disabled", async () => {
    const api = createApi({
      pluginConfig: { tradeEnabled: false },
    });
    const tool = createPolymarketTool({ api, ctx: { sandboxed: false, sessionKey: "sess" } });

    const result = await tool.execute("call", {
      action: "place_order",
      tokenId: "token",
      side: "buy",
      price: 0.5,
      size: 10,
    });

    expect(result.details).toMatchObject({
      ok: false,
      error: { type: "trading_disabled" },
    });
  });

  it("blocks place_order when private key is missing", async () => {
    const api = createApi({
      pluginConfig: { tradeEnabled: true, privateKeyEnvVar: "POLYMARKET_PRIVATE_KEY" },
    });
    delete process.env.POLYMARKET_PRIVATE_KEY;
    const tool = createPolymarketTool({ api, ctx: { sandboxed: false, sessionKey: "sess" } });

    const result = await tool.execute("call", {
      action: "place_order",
      tokenId: "token",
      side: "buy",
      price: 0.5,
      size: 10,
    });

    expect(result.details).toMatchObject({
      ok: false,
      error: { type: "missing_private_key" },
    });
  });

  it("returns needs_approval with a resumable token", async () => {
    const api = createApi({
      pluginConfig: { tradeEnabled: true, maxNotionalUsd: 100 },
    });
    process.env.POLYMARKET_PRIVATE_KEY = `0x${"11".repeat(32)}`;

    const tool = createPolymarketTool({ api, ctx: { sandboxed: false, sessionKey: "sess" } });

    const prepared = await tool.execute("call", {
      action: "place_order",
      tokenId: "token",
      side: "buy",
      price: 0.5,
      size: 10,
    });

    expect(prepared.details).toMatchObject({
      ok: true,
      status: "needs_approval",
      requiresApproval: expect.objectContaining({
        type: "approval_request",
        resumeToken: expect.any(String),
      }),
    });

    const token = (prepared.details as any).requiresApproval.resumeToken as string;

    const cancelled = await tool.execute("call", {
      action: "resume",
      token,
      approve: false,
    });

    expect(cancelled.details).toMatchObject({ ok: true, status: "cancelled" });
  });

  it("requires marketSlug/marketId when allowlist is set", async () => {
    const api = createApi({
      pluginConfig: {
        tradeEnabled: true,
        maxNotionalUsd: 100,
        allowedMarketSlugs: ["btc-updown-15m-1769655600"],
      },
    });
    process.env.POLYMARKET_PRIVATE_KEY = `0x${"33".repeat(32)}`;
    const tool = createPolymarketTool({ api, ctx: { sandboxed: false, sessionKey: "sess" } });

    const result = await tool.execute("call", {
      action: "place_order",
      tokenId: "token",
      side: "buy",
      price: 0.5,
      size: 1,
    });

    expect(result.details).toMatchObject({
      ok: false,
      error: { type: "market_required" },
    });
  });

  it("rejects tampered resume tokens", async () => {
    const api = createApi({
      pluginConfig: { tradeEnabled: true, maxNotionalUsd: 100 },
    });
    process.env.POLYMARKET_PRIVATE_KEY = `0x${"22".repeat(32)}`;

    const tool = createPolymarketTool({ api, ctx: { sandboxed: false, sessionKey: "sess" } });

    const prepared = await tool.execute("call", {
      action: "place_order",
      tokenId: "token",
      side: "buy",
      price: 0.5,
      size: 10,
    });
    const token = (prepared.details as any).requiresApproval.resumeToken as string;
    const tampered = token.replace(/.$/, "x");

    const result = await tool.execute("call", {
      action: "resume",
      token: tampered,
      approve: false,
    });

    expect(result.details).toMatchObject({
      ok: false,
      error: { type: "error" },
    });
  });
});

