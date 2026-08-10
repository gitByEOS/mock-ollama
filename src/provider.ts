import type { ApiFormat } from "./bridge/matrix";

export type ApiStyle = "auto" | ApiFormat;
export type AgentApiConfig = Readonly<{ chat: string; tags: string }>;
export type ProviderConfig = Readonly<{
    name: string;
    baseUrl: string;
    apikey: string;
    apiPath: AgentApiConfig;
    apiStyle: ApiStyle;
}>;

export type ProviderContext = Readonly<{
    config: ProviderConfig;
    upstreamFormat: ApiFormat;
    bridge: boolean;
    contextLength: number;
}>;

const ANTHROPIC_API_PATH: AgentApiConfig = { chat: "/v1/messages", tags: "/v1/models" };
const OPENAI_API_PATH: AgentApiConfig = { chat: "/v1/chat/completions", tags: "/v1/models" };
const RESPONSES_API_PATH: AgentApiConfig = { chat: "/v1/responses", tags: "/v1/models" };
export const FORMAT_PATH: Record<ApiFormat, string> = {
    anthropic: "/v1/messages",
    responses: "/v1/responses",
    chat: "/v1/chat/completions",
};

const PROVIDER_NAME_RULES = [
    ["anthropic.com", "anthropic"], ["bigmodel.cn", "zhipu"], ["deepseek.com", "deepseek"],
    ["moonshot.cn", "moonshot"], ["dashscope.aliyuncs.com", "aliyun"], ["siliconflow.cn", "siliconflow"],
    ["qianfan.baidubce.com", "baidu"], ["minimaxi.com", "minimax"], ["minimax.io", "minimax-global"],
    ["lingyiwanwu.com", "yi"], ["/anthropic", "anthropic"],
] as const;

export function processProviderName(baseUrl: string): string {
    const matched = PROVIDER_NAME_RULES.find(([match]) => baseUrl.includes(match))?.[1];
    if (matched) return matched;
    try {
        return new URL(baseUrl).hostname || "unknown";
    } catch {
        return "unknown";
    }
}

export function detectUpstreamFormat(baseUrl: string): ApiFormat {
    const normalized = baseUrl.toLowerCase();
    if (normalized.includes("anthropic") || normalized.includes("/messages")) return "anthropic";
    if (normalized.includes("/responses") || normalized.includes("responses-api") || normalized.includes("api-style=responses")) {
        return "responses";
    }
    return "chat";
}

export function resolveUpstreamFormat(baseUrl: string, apiStyle: ApiStyle): ApiFormat {
    return apiStyle === "auto" ? detectUpstreamFormat(baseUrl) : apiStyle;
}

export function processApiPath(baseUrl: string, apiStyle: ApiStyle): AgentApiConfig {
    const format = resolveUpstreamFormat(baseUrl, apiStyle);
    if (format === "anthropic") return ANTHROPIC_API_PATH;
    if (format === "responses") return RESPONSES_API_PATH;
    return OPENAI_API_PATH;
}

export function parseApiStyle(value: unknown): ApiStyle {
    if (value === undefined || value === null || value === "") return "auto";
    if (value === "anthropic" || value === "responses" || value === "chat" || value === "auto") return value;
    throw new TypeError(`Unsupported apiStyle: ${String(value)}`);
}

export function createProviderContext(options: {
    baseUrl: string;
    apikey: string;
    apiStyle?: unknown;
    bridge?: boolean;
    contextLength?: number;
}): ProviderContext {
    const baseUrl = options.baseUrl.endsWith("/") ? options.baseUrl.slice(0, -1) : options.baseUrl;
    const apiStyle = parseApiStyle(options.apiStyle);
    const config: ProviderConfig = Object.freeze({
            name: processProviderName(baseUrl),
            baseUrl,
            apikey: options.apikey,
            apiPath: processApiPath(baseUrl, apiStyle),
            apiStyle,
    });
    return Object.freeze({
        config,
        upstreamFormat: resolveUpstreamFormat(baseUrl, apiStyle),
        bridge: options.bridge ?? false,
        contextLength: options.contextLength ?? 200_000,
    });
}

export function configureProvider(options: Parameters<typeof createProviderContext>[0]): ProviderContext {
    return createProviderContext(options);
}
