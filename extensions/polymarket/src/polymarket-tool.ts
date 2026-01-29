import { Type } from "@sinclair/typebox";
import { createHash, createHmac, timingSafeEqual } from "node:crypto";

import {
  AssetType,
  ClobClient,
  COLLATERAL_TOKEN_DECIMALS,
  CONDITIONAL_TOKEN_DECIMALS,
  OrderType,
  Side,
} from "@polymarket/clob-client";
import { Wallet } from "ethers";

type PluginApi = {
  pluginConfig?: Record<string, unknown>;
  logger?: { warn?: (msg: string) => void };
};

type ToolResult<TDetails = unknown> = {
  content: Array<{ type: "text"; text: string }>;
  details: TDetails;
};

type StringParamOptions = {
  required?: boolean;
  trim?: boolean;
  label?: string;
  allowEmpty?: boolean;
};

function readStringParam(params: Record<string, unknown>, key: string, options: StringParamOptions & { required: true }): string;
function readStringParam(params: Record<string, unknown>, key: string, options?: StringParamOptions): string;
function readStringParam(params: Record<string, unknown>, key: string, options: StringParamOptions = {}) {
  const { required = false, trim = true, label = key, allowEmpty = false } = options;
  const raw = params[key];
  if (typeof raw !== "string") {
    if (required) throw new Error(`${label} required`);
    return "";
  }
  const value = trim ? raw.trim() : raw;
  if (!value && !allowEmpty) {
    if (required) throw new Error(`${label} required`);
    return "";
  }
  return value;
}

function readNumberParam(
  params: Record<string, unknown>,
  key: string,
  options: { required?: boolean; label?: string; integer?: boolean } = {},
): number {
  const { required = false, label = key, integer = false } = options;
  const raw = params[key];
  let value: number | undefined;
  if (typeof raw === "number" && Number.isFinite(raw)) {
    value = raw;
  } else if (typeof raw === "string") {
    const trimmed = raw.trim();
    if (trimmed) {
      const parsed = Number.parseFloat(trimmed);
      if (Number.isFinite(parsed)) value = parsed;
    }
  }
  if (value === undefined) {
    if (required) throw new Error(`${label} required`);
    throw new Error(`${label} required`);
  }
  return integer ? Math.trunc(value) : value;
}

function jsonResult(payload: unknown): ToolResult<unknown> {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(payload, null, 2),
      },
    ],
    details: payload,
  };
}

type ToolContext = {
  sandboxed?: boolean;
  sessionKey?: string;
};

type PluginConfig = {
  clobHost: string;
  gammaHost: string;
  chainId: number;
  privateKeyEnvVar: string;
  signatureType: 0 | 1 | 2;
  funderAddress?: string;
  tradeEnabled: boolean;
  maxNotionalUsd: number;
  allowedMarketSlugs?: string[];
};

type GammaMarket = {
  id?: string;
  slug?: string | null;
  question?: string | null;
  outcomes?: string | null;
  outcomePrices?: string | null;
  clobTokenIds?: string | null;
  active?: boolean | null;
  closed?: boolean | null;
  acceptingOrders?: boolean | null;
  orderMinSize?: number | null;
  orderPriceMinTickSize?: number | null;
};

type PendingOrder = {
  action: "place_order";
  createdAtMs: number;
  expiresAtMs: number;
  sessionKey?: string;
  market: { id?: string; slug?: string; question?: string };
  tokenId: string;
  side: "buy" | "sell";
  outcome?: string;
  price: number;
  size: number;
  approxNotionalUsd: number;
};

const ACTIONS = [
  "status",
  "balances",
  "positions",
  "open_orders",
  "trades",
  "order",
  "cancel_order",
  "cancel_all",
  "search",
  "market",
  "orderbook",
  "place_order",
  "resume",
] as const;

const PolymarketToolSchema = Type.Object({
  // NOTE: Prefer string enums (avoid unions/anyOf) for tool provider compatibility.
  action: Type.Unsafe<(typeof ACTIONS)[number]>({ type: "string", enum: ACTIONS }),

  // Shared / read-only
  query: Type.Optional(Type.String({ description: "Search query (Gamma public-search)." })),
  limit: Type.Optional(Type.Number({ description: "Max results to return (1-25).", minimum: 1, maximum: 25 })),
  marketId: Type.Optional(Type.String({ description: "Gamma market id." })),
  marketSlug: Type.Optional(Type.String({ description: "Gamma market slug." })),
  tokenId: Type.Optional(Type.String({ description: "CLOB token id (YES/NO token)." })),
  orderId: Type.Optional(Type.String({ description: "CLOB order id." })),
  confirm: Type.Optional(
    Type.Boolean({ description: "Explicit confirmation for destructive actions like cancel_all." }),
  ),

  // Trading (place_order)
  outcome: Type.Optional(Type.String({ description: "Outcome label to map to a tokenId (e.g. Yes/No). Optional if tokenId is provided." })),
  side: Type.Optional(
    Type.Unsafe<"buy" | "sell">({ type: "string", enum: ["buy", "sell"] }),
  ),
  price: Type.Optional(
    Type.Number({
      description: "Limit price per share (0-1).",
      minimum: 0,
      maximum: 1,
    }),
  ),
  size: Type.Optional(
    Type.Number({
      description: "Order size in shares (positive number).",
      exclusiveMinimum: 0,
    }),
  ),

  // Approval resume
  token: Type.Optional(Type.String({ description: "Resume token returned by place_order." })),
  approve: Type.Optional(Type.Boolean({ description: "Approve or reject the pending action." })),
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function normalizeUrl(value: unknown, fallback: string): string {
  const raw = typeof value === "string" ? value.trim() : "";
  if (!raw) return fallback;
  return raw.replace(/\/+$/, "");
}

function normalizeEnvVarName(value: unknown, fallback: string): string {
  const raw = typeof value === "string" ? value.trim() : "";
  return raw || fallback;
}

function normalizeSignatureType(value: unknown, fallback: 0 | 1 | 2): 0 | 1 | 2 {
  const num =
    typeof value === "number" && Number.isFinite(value)
      ? Math.trunc(value)
      : typeof value === "string" && value.trim()
        ? Number.parseInt(value.trim(), 10)
        : NaN;
  if (num === 0 || num === 1 || num === 2) return num;
  return fallback;
}

function normalizeNumber(value: unknown, fallback: number): number {
  const num =
    typeof value === "number" && Number.isFinite(value)
      ? value
      : typeof value === "string" && value.trim()
        ? Number.parseFloat(value.trim())
        : NaN;
  if (!Number.isFinite(num)) return fallback;
  return num;
}

function normalizeBoolean(value: unknown, fallback: boolean): boolean {
  if (typeof value === "boolean") return value;
  return fallback;
}

function normalizeStringList(value: unknown): string[] | undefined {
  if (Array.isArray(value)) {
    const items = value
      .map((entry) => (typeof entry === "string" ? entry.trim() : ""))
      .filter(Boolean);
    return items.length > 0 ? items : undefined;
  }
  if (typeof value === "string" && value.trim()) return [value.trim()];
  return undefined;
}

function resolvePluginConfig(api: PluginApi): PluginConfig {
  const raw = isRecord(api.pluginConfig) ? api.pluginConfig : {};

  const clobHost = normalizeUrl(raw.clobHost, "https://clob.polymarket.com");
  const gammaHost = normalizeUrl(raw.gammaHost, "https://gamma-api.polymarket.com");
  const chainId = Math.trunc(normalizeNumber(raw.chainId, 137));
  const privateKeyEnvVar = normalizeEnvVarName(raw.privateKeyEnvVar, "POLYMARKET_PRIVATE_KEY");
  const signatureType = normalizeSignatureType(raw.signatureType, 0);
  const funderAddress = typeof raw.funderAddress === "string" ? raw.funderAddress.trim() : "";
  const tradeEnabled = normalizeBoolean(raw.tradeEnabled, false);
  const maxNotionalUsd = Math.max(0, normalizeNumber(raw.maxNotionalUsd, 25));
  const allowedMarketSlugs = normalizeStringList(raw.allowedMarketSlugs);

  return {
    clobHost,
    gammaHost,
    chainId,
    privateKeyEnvVar,
    signatureType,
    funderAddress: funderAddress || undefined,
    tradeEnabled,
    maxNotionalUsd,
    allowedMarketSlugs,
  };
}

function resolvePrivateKey(config: PluginConfig): string | undefined {
  const fromPrimary = (process.env[config.privateKeyEnvVar] ?? "").trim();
  const fromFallback = (process.env.POLYMARKET_PRIVATE_KEY ?? "").trim();
  const fromDocs = (process.env.PRIVATE_KEY ?? "").trim();
  const raw = fromPrimary || fromFallback || fromDocs;
  if (!raw) return undefined;
  return raw.startsWith("0x") ? raw : `0x${raw}`;
}

function createTokenKey(privateKey: string): Buffer {
  // Derive an HMAC key from the trading private key (kept server-side). This avoids
  // storing an extra approval secret while still preventing token tampering.
  return createHash("sha256").update(privateKey, "utf8").digest();
}

function signToken(payloadJson: string, key: Buffer): string {
  return createHmac("sha256", key).update(payloadJson, "utf8").digest("base64url");
}

function encodeResumeToken(payload: PendingOrder, privateKey: string): string {
  const payloadJson = JSON.stringify(payload);
  const key = createTokenKey(privateKey);
  const sig = signToken(payloadJson, key);
  const body = Buffer.from(payloadJson, "utf8").toString("base64url");
  return `${body}.${sig}`;
}

function decodeResumeToken(token: string, privateKey: string): PendingOrder {
  const parts = token.split(".");
  if (parts.length !== 2) throw new Error("Invalid token format");
  const [body, sig] = parts;
  const json = Buffer.from(body, "base64url").toString("utf8");
  const key = createTokenKey(privateKey);
  const expected = signToken(json, key);
  const a = Buffer.from(sig, "utf8");
  const b = Buffer.from(expected, "utf8");
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    throw new Error("Invalid token signature");
  }
  const parsed = JSON.parse(json) as unknown;
  if (!isRecord(parsed)) throw new Error("Invalid token payload");
  return parsed as PendingOrder;
}

function parseJsonStringArray(value: unknown): string[] | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (!Array.isArray(parsed)) return undefined;
    const out = parsed.map((e) => (typeof e === "string" ? e : "")).filter(Boolean);
    return out.length > 0 ? out : undefined;
  } catch {
    return undefined;
  }
}

function normalizeOutcomeLabel(value: string): string {
  return value.trim().toLowerCase();
}

function resolveOutcomeToken(params: {
  market: GammaMarket;
  outcome?: string;
}): { tokenId: string; outcome?: string } {
  const tokens = parseJsonStringArray(params.market.clobTokenIds) ?? [];
  if (tokens.length === 0) {
    throw new Error("Market is missing clobTokenIds; cannot trade via CLOB");
  }
  const outcomes = parseJsonStringArray(params.market.outcomes) ?? [];
  const normalizedOutcome = params.outcome ? normalizeOutcomeLabel(params.outcome) : undefined;

  if (normalizedOutcome && outcomes.length === tokens.length && outcomes.length > 0) {
    const idx = outcomes.findIndex((o) => normalizeOutcomeLabel(o) === normalizedOutcome);
    if (idx >= 0 && tokens[idx]) {
      return { tokenId: tokens[idx], outcome: outcomes[idx] };
    }
    throw new Error(`Unknown outcome: ${params.outcome}`);
  }

  // Fallback heuristic for binary Yes/No markets.
  if (normalizedOutcome === "yes" && tokens[0]) return { tokenId: tokens[0], outcome: "Yes" };
  if (normalizedOutcome === "no" && tokens[1]) return { tokenId: tokens[1], outcome: "No" };

  if (!normalizedOutcome && tokens[0]) {
    return { tokenId: tokens[0], outcome: outcomes[0] ?? undefined };
  }

  // If we can't map outcome safely, force explicit tokenId.
  throw new Error("Provide tokenId (or a resolvable outcome) to place an order");
}

async function fetchJson<T>(url: string, signal?: AbortSignal): Promise<T> {
  const res = await fetch(url, {
    method: "GET",
    headers: { Accept: "application/json" },
    signal,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`HTTP ${res.status}: ${text || res.statusText}`);
  }
  return (await res.json()) as T;
}

function isAllowedMarket(params: { config: PluginConfig; marketSlug?: string | null | undefined }): boolean {
  const allow = params.config.allowedMarketSlugs;
  if (!allow || allow.length === 0) return true;
  const slug = (params.marketSlug ?? "").trim();
  if (!slug) return false;
  return allow.some((entry) => entry.trim() === slug);
}

function approxNotionalUsd(price: number, size: number): number {
  // For Polymarket CLOB, the quickstart shows `price` is $/share and `size` is shares.
  // Approx notional is price * size (fees not included).
  return price * size;
}

function formatUnits(raw: string, decimals: number): string {
  const trimmed = raw.trim();
  if (!/^[0-9]+$/.test(trimmed)) return trimmed;
  if (decimals <= 0) return trimmed;
  const pad = trimmed.padStart(decimals + 1, "0");
  const whole = pad.slice(0, -decimals);
  const frac = pad.slice(-decimals).replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : whole;
}

function clampLimit(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function normalizeLimit(value: unknown): number {
  const num =
    typeof value === "number" && Number.isFinite(value)
      ? value
      : typeof value === "string" && value.trim()
        ? Number.parseInt(value.trim(), 10)
        : NaN;
  if (!Number.isFinite(num)) return 5;
  return Math.trunc(clampLimit(num, 1, 25));
}

function buildApprovalPrompt(order: PendingOrder) {
  const lines = [
    "You are about to place a Polymarket order.",
    "",
    `Market: ${order.market.question ?? order.market.slug ?? order.market.id ?? "(unknown)"}`,
    order.market.slug ? `Slug: ${order.market.slug}` : undefined,
    `Token ID: ${order.tokenId}`,
    order.outcome ? `Outcome: ${order.outcome}` : undefined,
    `Side: ${order.side.toUpperCase()}`,
    `Price: ${order.price}`,
    `Size: ${order.size}`,
    `Approx notional (USD): ${order.approxNotionalUsd.toFixed(2)}`,
    "",
    "Reply with approval to continue, or reject to cancel.",
  ].filter(Boolean) as string[];
  return lines.join("\n");
}

async function resolveGammaMarket(params: {
  config: PluginConfig;
  marketId?: string;
  marketSlug?: string;
  signal?: AbortSignal;
}): Promise<GammaMarket> {
  if (params.marketSlug) {
    const url = `${params.config.gammaHost}/markets/slug/${encodeURIComponent(params.marketSlug)}`;
    return await fetchJson<GammaMarket>(url, params.signal);
  }
  if (params.marketId) {
    const url = `${params.config.gammaHost}/markets/${encodeURIComponent(params.marketId)}`;
    return await fetchJson<GammaMarket>(url, params.signal);
  }
  throw new Error("marketSlug or marketId required");
}

async function resolveClobClient(params: {
  config: PluginConfig;
  privateKey: string;
  signal?: AbortSignal;
}): Promise<{
  signer: Wallet;
  client: ClobClient;
  funderAddress: string;
}> {
  const signer = new Wallet(params.privateKey);
  const l1Client = new ClobClient(params.config.clobHost, params.config.chainId, signer);
  const userApiCreds = await l1Client.createOrDeriveApiKey();

  const signatureType = params.config.signatureType;
  const funderAddress =
    params.config.funderAddress ??
    (signatureType === 0 ? signer.address : undefined);
  if (!funderAddress) {
    throw new Error(
      "Missing funderAddress for signatureType 1/2. Set plugins.entries.polymarket.config.funderAddress.",
    );
  }
  const client = new ClobClient(
    params.config.clobHost,
    params.config.chainId,
    signer,
    userApiCreds,
    signatureType,
    funderAddress,
  );

  return { signer, client, funderAddress };
}

function isMultipleOfTick(value: number, tickSize: number): boolean {
  if (!Number.isFinite(tickSize) || tickSize <= 0) return true;
  const scaled = value / tickSize;
  const rounded = Math.round(scaled);
  return Math.abs(rounded - scaled) < 1e-9;
}

export function createPolymarketTool(params: { api: PluginApi; ctx: ToolContext }) {
  const config = resolvePluginConfig(params.api);

  return {
    name: "polymarket",
    label: "Polymarket",
    description:
      "Read Polymarket markets and orderbooks (Gamma + CLOB). Can place CLOB orders with resumable approvals when trading is enabled.",
    parameters: PolymarketToolSchema,
    async execute(_toolCallId: string, rawParams: Record<string, unknown>, signal?: AbortSignal) {
      const respond = (payload: unknown) => jsonResult(payload);
      try {
        const action = readStringParam(rawParams, "action", { required: true }) as (typeof ACTIONS)[number];

        if (action === "status") {
          const envVarPresent = Boolean(resolvePrivateKey(config));
          const allow = config.allowedMarketSlugs ?? [];
          return respond({
            ok: true,
            status: "ok",
            config: {
              clobHost: config.clobHost,
              gammaHost: config.gammaHost,
              chainId: config.chainId,
              signatureType: config.signatureType,
              funderAddress: config.funderAddress ? "(configured)" : "(unset)",
              tradeEnabled: config.tradeEnabled,
              maxNotionalUsd: config.maxNotionalUsd,
              allowedMarketSlugs:
                allow.length > 25
                  ? [
                      allow[0] ?? "",
                      allow[1] ?? "",
                      allow[2] ?? "",
                      `...${allow.length} total slugs...`,
                    ].filter(Boolean)
                  : allow,
              privateKeyEnvVar: config.privateKeyEnvVar,
              privateKeyPresent: envVarPresent,
            },
          });
        }

        if (action === "balances") {
          const privateKey = resolvePrivateKey(config);
          if (!privateKey) {
            return respond({
              ok: false,
              error: {
                type: "missing_private_key",
                message: `Missing Polymarket private key. Set ${config.privateKeyEnvVar} (or POLYMARKET_PRIVATE_KEY / PRIVATE_KEY) in the gateway environment.`,
              },
            });
          }
          const { client } = await resolveClobClient({ config, privateKey, signal });
          const collateral = (await client.getBalanceAllowance({ asset_type: AssetType.COLLATERAL })) as {
            balance?: string;
            allowances?: Record<string, string>;
          };
          const raw = collateral?.balance ?? "0";
          return respond({
            ok: true,
            status: "ok",
            collateral: {
              balanceRaw: raw,
              balance: formatUnits(raw, COLLATERAL_TOKEN_DECIMALS),
              allowances: collateral?.allowances ?? {},
            },
          });
        }

        if (action === "positions") {
          const marketSlug = readStringParam(rawParams, "marketSlug");
          const marketId = readStringParam(rawParams, "marketId");
          const outcome = readStringParam(rawParams, "outcome");
          const market = await resolveGammaMarket({ config, marketId, marketSlug, signal });
          const outcomes = parseJsonStringArray(market.outcomes) ?? [];
          const tokenIds = parseJsonStringArray(market.clobTokenIds) ?? [];
          if (outcomes.length === 0 || tokenIds.length === 0 || outcomes.length !== tokenIds.length) {
            return respond({
              ok: false,
              error: { type: "missing_tokens", message: "Market is missing outcomes/clobTokenIds." },
            });
          }

          const privateKey = resolvePrivateKey(config);
          if (!privateKey) {
            return respond({
              ok: false,
              error: {
                type: "missing_private_key",
                message: `Missing Polymarket private key. Set ${config.privateKeyEnvVar} (or POLYMARKET_PRIVATE_KEY / PRIVATE_KEY) in the gateway environment.`,
              },
            });
          }
          const { client } = await resolveClobClient({ config, privateKey, signal });
          const normalizedOutcome = outcome ? normalizeOutcomeLabel(outcome) : undefined;

          const entries: Array<{
            outcome: string;
            tokenId: string;
            balanceRaw: string;
            balance: string;
          }> = [];

          for (let i = 0; i < outcomes.length; i += 1) {
            const label = outcomes[i] ?? "";
            const tokenId = tokenIds[i] ?? "";
            if (!label || !tokenId) continue;
            if (normalizedOutcome && normalizeOutcomeLabel(label) !== normalizedOutcome) continue;
            const bal = (await client.getBalanceAllowance({
              asset_type: AssetType.CONDITIONAL,
              token_id: tokenId,
            })) as { balance?: string };
            const raw = bal?.balance ?? "0";
            entries.push({
              outcome: label,
              tokenId,
              balanceRaw: raw,
              balance: formatUnits(raw, CONDITIONAL_TOKEN_DECIMALS),
            });
          }

          return respond({
            ok: true,
            status: "ok",
            market: {
              id: market.id ?? undefined,
              slug: market.slug ?? undefined,
              question: market.question ?? undefined,
            },
            positions: entries,
          });
        }

        if (action === "open_orders") {
          const privateKey = resolvePrivateKey(config);
          if (!privateKey) {
            return respond({
              ok: false,
              error: {
                type: "missing_private_key",
                message: `Missing Polymarket private key. Set ${config.privateKeyEnvVar} (or POLYMARKET_PRIVATE_KEY / PRIVATE_KEY) in the gateway environment.`,
              },
            });
          }
          const { client } = await resolveClobClient({ config, privateKey, signal });

          const tokenId = readStringParam(rawParams, "tokenId");
          const marketSlug = readStringParam(rawParams, "marketSlug");
          const marketId = readStringParam(rawParams, "marketId");
          const outcome = readStringParam(rawParams, "outcome");

          if (tokenId) {
            const orders = await client.getOpenOrders({ asset_id: tokenId }, true);
            return respond({ ok: true, status: "ok", tokenId, orders });
          }

          if (marketSlug || marketId) {
            const market = await resolveGammaMarket({ config, marketId, marketSlug, signal });
            const outcomes = parseJsonStringArray(market.outcomes) ?? [];
            const tokenIds = parseJsonStringArray(market.clobTokenIds) ?? [];
            if (outcomes.length === 0 || tokenIds.length === 0 || outcomes.length !== tokenIds.length) {
              return respond({
                ok: false,
                error: { type: "missing_tokens", message: "Market is missing outcomes/clobTokenIds." },
              });
            }

            const targets: Array<{ tokenId: string; outcome?: string }> = [];
            if (outcome) {
              const resolved = resolveOutcomeToken({ market, outcome });
              targets.push({ tokenId: resolved.tokenId, outcome: resolved.outcome });
            } else {
              for (let i = 0; i < tokenIds.length; i += 1) {
                targets.push({ tokenId: tokenIds[i] ?? "", outcome: outcomes[i] ?? undefined });
              }
            }

            const results: Array<{ tokenId: string; outcome?: string; orders: unknown }> = [];
            for (const entry of targets) {
              if (!entry.tokenId) continue;
              const orders = await client.getOpenOrders({ asset_id: entry.tokenId }, true);
              results.push({ tokenId: entry.tokenId, outcome: entry.outcome, orders });
            }

            return respond({
              ok: true,
              status: "ok",
              market: { id: market.id ?? undefined, slug: market.slug ?? undefined, question: market.question ?? undefined },
              results,
            });
          }

          const orders = await client.getOpenOrders({}, true);
          return respond({ ok: true, status: "ok", orders });
        }

        if (action === "trades") {
          const privateKey = resolvePrivateKey(config);
          if (!privateKey) {
            return respond({
              ok: false,
              error: {
                type: "missing_private_key",
                message: `Missing Polymarket private key. Set ${config.privateKeyEnvVar} (or POLYMARKET_PRIVATE_KEY / PRIVATE_KEY) in the gateway environment.`,
              },
            });
          }
          const { client } = await resolveClobClient({ config, privateKey, signal });

          const tokenId = readStringParam(rawParams, "tokenId");
          const marketSlug = readStringParam(rawParams, "marketSlug");
          const marketId = readStringParam(rawParams, "marketId");
          const outcome = readStringParam(rawParams, "outcome");
          const limit = normalizeLimit(rawParams.limit);

          if (tokenId) {
            const trades = (await client.getTrades({ asset_id: tokenId }, true)) as unknown[];
            return respond({ ok: true, status: "ok", tokenId, trades: trades.slice(0, limit) });
          }

          if (marketSlug || marketId) {
            const market = await resolveGammaMarket({ config, marketId, marketSlug, signal });
            const outcomes = parseJsonStringArray(market.outcomes) ?? [];
            const tokenIds = parseJsonStringArray(market.clobTokenIds) ?? [];
            if (outcomes.length === 0 || tokenIds.length === 0 || outcomes.length !== tokenIds.length) {
              return respond({
                ok: false,
                error: { type: "missing_tokens", message: "Market is missing outcomes/clobTokenIds." },
              });
            }

            const targets: Array<{ tokenId: string; outcome?: string }> = [];
            if (outcome) {
              const resolved = resolveOutcomeToken({ market, outcome });
              targets.push({ tokenId: resolved.tokenId, outcome: resolved.outcome });
            } else {
              for (let i = 0; i < tokenIds.length; i += 1) {
                targets.push({ tokenId: tokenIds[i] ?? "", outcome: outcomes[i] ?? undefined });
              }
            }

            const results: Array<{ tokenId: string; outcome?: string; trades: unknown[] }> = [];
            for (const entry of targets) {
              if (!entry.tokenId) continue;
              const trades = (await client.getTrades({ asset_id: entry.tokenId }, true)) as unknown[];
              results.push({ tokenId: entry.tokenId, outcome: entry.outcome, trades: trades.slice(0, limit) });
            }

            return respond({
              ok: true,
              status: "ok",
              market: { id: market.id ?? undefined, slug: market.slug ?? undefined, question: market.question ?? undefined },
              results,
            });
          }

          const trades = (await client.getTrades({}, true)) as unknown[];
          return respond({ ok: true, status: "ok", trades: trades.slice(0, limit) });
        }

        if (action === "order") {
          const orderId = readStringParam(rawParams, "orderId", { required: true });
          const privateKey = resolvePrivateKey(config);
          if (!privateKey) {
            return respond({
              ok: false,
              error: {
                type: "missing_private_key",
                message: `Missing Polymarket private key. Set ${config.privateKeyEnvVar} (or POLYMARKET_PRIVATE_KEY / PRIVATE_KEY) in the gateway environment.`,
              },
            });
          }
          const { client } = await resolveClobClient({ config, privateKey, signal });
          const order = await client.getOrder(orderId);
          return respond({ ok: true, status: "ok", orderId, order });
        }

        if (action === "cancel_order") {
          if (params.ctx.sandboxed) {
            return respond({
              ok: false,
              error: { type: "sandboxed", message: "Cancel is blocked in sandboxed environments." },
            });
          }
          const orderId = readStringParam(rawParams, "orderId", { required: true });
          const privateKey = resolvePrivateKey(config);
          if (!privateKey) {
            return respond({
              ok: false,
              error: {
                type: "missing_private_key",
                message: `Missing Polymarket private key. Set ${config.privateKeyEnvVar} (or POLYMARKET_PRIVATE_KEY / PRIVATE_KEY) in the gateway environment.`,
              },
            });
          }
          const { client } = await resolveClobClient({ config, privateKey, signal });
          const result = await client.cancelOrder({ orderID: orderId });
          return respond({ ok: true, status: "ok", orderId, result });
        }

        if (action === "cancel_all") {
          if (params.ctx.sandboxed) {
            return respond({
              ok: false,
              error: { type: "sandboxed", message: "Cancel is blocked in sandboxed environments." },
            });
          }
          if (rawParams.confirm !== true) {
            return respond({
              ok: false,
              error: {
                type: "confirmation_required",
                message: 'cancel_all requires {"confirm": true}.',
              },
            });
          }
          const privateKey = resolvePrivateKey(config);
          if (!privateKey) {
            return respond({
              ok: false,
              error: {
                type: "missing_private_key",
                message: `Missing Polymarket private key. Set ${config.privateKeyEnvVar} (or POLYMARKET_PRIVATE_KEY / PRIVATE_KEY) in the gateway environment.`,
              },
            });
          }
          const { client } = await resolveClobClient({ config, privateKey, signal });
          const result = await client.cancelAll();
          return respond({ ok: true, status: "ok", result });
        }

        if (action === "search") {
          const query = readStringParam(rawParams, "query", { required: true });
          const limit = normalizeLimit(rawParams.limit);
          const url = new URL(`${config.gammaHost}/public-search`);
          url.searchParams.set("q", query);
          url.searchParams.set("limit_per_type", String(limit));
          url.searchParams.set("search_profiles", "false");
          url.searchParams.set("search_tags", "false");
          const data = await fetchJson<Record<string, unknown>>(url.toString(), signal);
          return respond({ ok: true, status: "ok", query, results: data });
        }

        if (action === "market") {
          const marketSlug = readStringParam(rawParams, "marketSlug");
          const marketId = readStringParam(rawParams, "marketId");
          const market = await resolveGammaMarket({ config, marketId, marketSlug, signal });
          const parsed = {
            ...market,
            outcomesParsed: parseJsonStringArray(market.outcomes) ?? [],
            outcomePricesParsed: parseJsonStringArray(market.outcomePrices) ?? [],
            clobTokenIdsParsed: parseJsonStringArray(market.clobTokenIds) ?? [],
          };
          return respond({ ok: true, status: "ok", market: parsed });
        }

        if (action === "orderbook") {
          const tokenId = readStringParam(rawParams, "tokenId", { required: true });
          const url = new URL(`${config.clobHost}/book`);
          url.searchParams.set("token_id", tokenId);
          const book = await fetchJson<Record<string, unknown>>(url.toString(), signal);
          return respond({ ok: true, status: "ok", tokenId, book });
        }

        if (action === "place_order") {
          if (!config.tradeEnabled) {
            return respond({
              ok: false,
              error: {
                type: "trading_disabled",
                message:
                  "Trading is disabled. Set plugins.entries.polymarket.config.tradeEnabled=true to enable order placement.",
              },
              docs: "https://docs.polymarket.com/quickstart/first-order",
            });
          }
          if (params.ctx.sandboxed) {
            return respond({
              ok: false,
              error: {
                type: "sandboxed",
                message: "Order placement is blocked in sandboxed environments.",
              },
            });
          }

          const privateKey = resolvePrivateKey(config);
          if (!privateKey) {
            return respond({
              ok: false,
              error: {
                type: "missing_private_key",
                message: `Missing Polymarket private key. Set ${config.privateKeyEnvVar} (or POLYMARKET_PRIVATE_KEY / PRIVATE_KEY) in the gateway environment.`,
              },
              docs: "https://docs.polymarket.com/quickstart/first-order",
            });
          }

          const tokenIdFromArgs = readStringParam(rawParams, "tokenId");
          const marketSlug = readStringParam(rawParams, "marketSlug");
          const marketId = readStringParam(rawParams, "marketId");
          const outcome = readStringParam(rawParams, "outcome");

          const hasAllowlist = Boolean(config.allowedMarketSlugs && config.allowedMarketSlugs.length > 0);

          // Enforce allowlist safety: if an allowlist exists, require a market id/slug so we can
          // validate the market before creating a resumable order (prevents tokenId-only bypass).
          let market: GammaMarket | null = null;
          if (marketSlug || marketId) {
            market = await resolveGammaMarket({ config, marketId, marketSlug, signal });
          } else if (hasAllowlist) {
            return respond({
              ok: false,
              error: {
                type: "market_required",
                message: "marketSlug or marketId required when allowedMarketSlugs is set.",
              },
            });
          }

          if (market && !isAllowedMarket({ config, marketSlug: market.slug })) {
            return respond({
              ok: false,
              error: {
                type: "market_not_allowed",
                message: `Market not allowed by allowedMarketSlugs: ${market.slug ?? "(unknown)"}`,
              },
            });
          }

          let tokenId: string;
          let resolvedOutcome: string | undefined;
          if (tokenIdFromArgs) {
            tokenId = tokenIdFromArgs;
          } else if (market) {
            const resolved = resolveOutcomeToken({ market, outcome });
            tokenId = resolved.tokenId;
            resolvedOutcome = resolved.outcome;
          } else {
            throw new Error("Provide tokenId (or provide marketSlug/marketId and outcome) to place an order");
          }

          const side = (readStringParam(rawParams, "side", { required: true }) as "buy" | "sell")
            .toLowerCase() as "buy" | "sell";
          if (side !== "buy" && side !== "sell") {
            throw new Error("side must be buy or sell");
          }

          const price = readNumberParam(rawParams, "price", { required: true });
          const size = readNumberParam(rawParams, "size", { required: true });
          if (price <= 0 || price >= 1) {
            throw new Error("price must be between 0 and 1 (exclusive)");
          }
          if (size <= 0) {
            throw new Error("size must be > 0");
          }

          const approx = approxNotionalUsd(price, size);
          if (config.maxNotionalUsd > 0 && approx > config.maxNotionalUsd) {
            return respond({
              ok: false,
              error: {
                type: "notional_limit",
                message: `Order notional ${approx.toFixed(2)} exceeds maxNotionalUsd ${config.maxNotionalUsd}.`,
              },
            });
          }

          const now = Date.now();
          const order: PendingOrder = {
            action: "place_order",
            createdAtMs: now,
            expiresAtMs: now + 5 * 60 * 1000,
            sessionKey: params.ctx.sessionKey ?? undefined,
            market: {
              id: market?.id,
              slug: market?.slug ?? marketSlug ?? undefined,
              question: market?.question ?? undefined,
            },
            tokenId,
            side,
            outcome: resolvedOutcome ?? outcome ?? undefined,
            price,
            size,
            approxNotionalUsd: approx,
          };

          const resumeToken = encodeResumeToken(order, privateKey);

          return respond({
            ok: true,
            status: "needs_approval",
            output: [],
            requiresApproval: {
              type: "approval_request",
              prompt: buildApprovalPrompt(order),
              items: [order],
              resumeToken,
            },
          });
        }

        if (action === "resume") {
          if (params.ctx.sandboxed) {
            return respond({
              ok: false,
              error: { type: "sandboxed", message: "Resume is blocked in sandboxed environments." },
            });
          }
          const token = readStringParam(rawParams, "token", { required: true });
          const approve = rawParams.approve;
          if (typeof approve !== "boolean") {
            throw new Error("approve required (boolean)");
          }

          const privateKey = resolvePrivateKey(config);
          if (!privateKey) {
            return respond({
              ok: false,
              error: {
                type: "missing_private_key",
                message: `Missing Polymarket private key. Set ${config.privateKeyEnvVar} (or POLYMARKET_PRIVATE_KEY / PRIVATE_KEY) in the gateway environment.`,
              },
            });
          }

          const pending = decodeResumeToken(token, privateKey);
          const now = Date.now();
          if (pending.expiresAtMs && now > pending.expiresAtMs) {
            return respond({
              ok: false,
              error: { type: "expired", message: "Approval token expired; re-run place_order." },
            });
          }
          if (pending.sessionKey && params.ctx.sessionKey && pending.sessionKey !== params.ctx.sessionKey) {
            return respond({
              ok: false,
              error: { type: "session_mismatch", message: "Approval token is bound to a different session." },
            });
          }
          if (!approve) {
            return respond({ ok: true, status: "cancelled", output: [], requiresApproval: null });
          }
          if (!config.tradeEnabled) {
            return respond({
              ok: false,
              error: { type: "trading_disabled", message: "Trading disabled in plugin config." },
            });
          }
          if (pending.action !== "place_order") {
            return respond({ ok: false, error: { type: "unsupported", message: "Unsupported token action." } });
          }
          if (config.allowedMarketSlugs && config.allowedMarketSlugs.length > 0) {
            if (!isAllowedMarket({ config, marketSlug: pending.market?.slug })) {
              return respond({
                ok: false,
                error: {
                  type: "market_not_allowed",
                  message: `Market not allowed by allowedMarketSlugs: ${pending.market?.slug ?? "(missing)"}`,
                },
              });
            }
          }

          const { client } = await resolveClobClient({ config, privateKey, signal });
          const tickSizeStr = await client.getTickSize(pending.tokenId);
          const tickSizeNum = Number.parseFloat(tickSizeStr);
          if (Number.isFinite(tickSizeNum) && !isMultipleOfTick(pending.price, tickSizeNum)) {
            return respond({
              ok: false,
              error: {
                type: "invalid_tick",
                message: `price ${pending.price} is not aligned to tickSize ${tickSizeStr}`,
              },
            });
          }
          const negRisk = Boolean(await client.getNegRisk(pending.tokenId));

          const orderType = OrderType.GTC;
          const side = pending.side === "buy" ? Side.BUY : Side.SELL;

          const response = await client.createAndPostOrder(
            {
              tokenID: pending.tokenId,
              price: pending.price,
              size: pending.size,
              side,
            },
            { tickSize: tickSizeStr, negRisk },
            orderType,
          );

          return respond({
            ok: true,
            status: "ok",
            output: [
              {
                orderID: (response as { orderID?: unknown }).orderID,
                status: (response as { status?: unknown }).status,
              },
            ],
            requiresApproval: null,
          });
        }

        return respond({
          ok: false,
          error: { type: "unknown_action", message: `Unknown action: ${String(rawParams.action)}` },
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        params.api.logger?.warn?.(`[polymarket] tool error: ${message}`);
        return jsonResult({ ok: false, error: { type: "error", message } });
      }
    },
  };
}

