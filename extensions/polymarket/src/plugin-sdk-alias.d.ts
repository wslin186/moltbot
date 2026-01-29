declare module "clawdbot/plugin-sdk" {
  export type MoltbotPluginApi = {
    pluginConfig?: Record<string, unknown>;
    logger?: { warn?: (msg: string) => void };
  };

  export type ToolResult<TDetails = unknown> = {
    details: TDetails;
  };

  export function jsonResult<T>(details: T): ToolResult<T>;

  export function readStringParam(
    params: Record<string, unknown>,
    key: string,
    opts?: { required?: boolean },
  ): string;

  export function readNumberParam(
    params: Record<string, unknown>,
    key: string,
    opts?: { required?: boolean },
  ): number;
}

declare module "moltbot/plugin-sdk" {
  export * from "clawdbot/plugin-sdk";
}

