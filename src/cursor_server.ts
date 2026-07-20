import { serve } from "@hono/node-server";
import { createCursorApp, type CursorModel } from "./cursor";
import { startQuickTunnel } from "./cursor_tunnel";

export type CursorTunnelMode = "quick" | "off";

export type CursorServerOptions = Readonly<{
    port: number;
    apiKey: string;
    upstream: string;
    tunnel: CursorTunnelMode;
    generatedKey: boolean;
}>;

function normalizeBaseUrl(value: string): string {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
        throw new TypeError("Cursor upstream must use http or https");
    }
    const path = url.pathname.replace(/\/+$/, "");
    return `${url.protocol}//${url.host}${path}`;
}

function maskApiKey(key: string): string {
    if (key.length <= 8) return "***";
    return `${key.slice(0, 4)}…${key.slice(-4)}`;
}

async function assertUpstream(baseUrl: string): Promise<void> {
    try {
        const response = await fetch(`${baseUrl}/api/version`, { signal: AbortSignal.timeout(5_000) });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
    } catch (error) {
        throw new Error(
            `Local mock-ollama is not ready at ${baseUrl}. Start it first, for example: mock-ollama --url <upstream> --apikey <key>. ${String(error)}`,
        );
    }
}

async function fetchModels(baseUrl: string): Promise<CursorModel[]> {
    const response = await fetch(`${baseUrl}/api/tags`, { signal: AbortSignal.timeout(10_000) });
    if (!response.ok) throw new Error(`Failed to fetch models from ${baseUrl}/api/tags: HTTP ${response.status}`);
    const body = await response.json() as { models?: Array<{ name?: unknown; model?: unknown }> };
    const models = body.models ?? [];
    if (models.length === 0) throw new Error(`No models available at ${baseUrl}. Add models to mock-ollama first.`);
    return models
        .map((item) => {
            const id = typeof item.name === "string" ? item.name : (typeof item.model === "string" ? item.model : "");
            return id ? { id } : null;
        })
        .filter((m): m is CursorModel => m !== null);
}

function printConfig(options: {
    baseUrl: string;
    apiKey: string;
    models: ReadonlyArray<CursorModel>;
    tunnel: CursorTunnelMode;
    generatedKey: boolean;
}) {
    const modelLines = options.models.map((m) => `  - ${m.id}`).join("\n");
    console.log([
        "",
        "========================================",
        " Cursor Settings → Models",
        "========================================",
        "  Override OpenAI Base URL: ON",
        `  Base URL:       ${options.baseUrl}`,
        `  OpenAI API Key: ${options.apiKey}`,
        "  Add model (任选其一或多):",
        modelLines,
        `  Tunnel mode:    ${options.tunnel}`,
        options.generatedKey ? "  API key is generated for this process" : `  API key (masked): ${maskApiKey(options.apiKey)}`,
        "========================================",
        "",
    ].join("\n"));
}

/** 启动 Cursor BYOK 公网代理：探活主服务、拉取模型、起 loopback 服务、套隧道、打印配置。 */
export async function startCursorServer(options: CursorServerOptions): Promise<void> {
    const upstreamBaseUrl = normalizeBaseUrl(options.upstream);
    await assertUpstream(upstreamBaseUrl);
    const models = await fetchModels(upstreamBaseUrl);
    const app = createCursorApp({ apiKey: options.apiKey, upstreamBaseUrl, models });

    let server!: ReturnType<typeof serve>;
    await new Promise<void>((resolve, reject) => {
        const onError = (error: Error) => reject(error);
        server = serve({ fetch: app.fetch, hostname: "127.0.0.1", port: options.port }, () => {
            server.off("error", onError);
            resolve();
        });
        server.once("error", onError);
    });

    let stopped = false;
    let tunnel: ReturnType<typeof startQuickTunnel> | null = null;
    const stop = async () => {
        if (stopped) return;
        stopped = true;
        tunnel?.stop();
        await new Promise<void>((resolve) => server.close(() => resolve()));
    };
    const shutdown = () => {
        void stop().finally(() => process.exit(0));
    };
    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);

    try {
        if (options.tunnel === "quick") {
            tunnel = startQuickTunnel(options.port);
            const publicUrl = await tunnel.url;
            tunnel.child.once("exit", (code, signal) => {
                if (!stopped) {
                    console.error(`Cloudflare quick tunnel stopped (code ${code ?? "none"}, signal ${signal ?? "none"})`);
                }
            });
            printConfig({ baseUrl: `${publicUrl}/v1`, apiKey: options.apiKey, models, tunnel: "quick", generatedKey: options.generatedKey });
        } else {
            printConfig({ baseUrl: `http://127.0.0.1:${options.port}/v1`, apiKey: options.apiKey, models, tunnel: "off", generatedKey: options.generatedKey });
        }
    } catch (error) {
        await stop();
        throw error;
    }
}
