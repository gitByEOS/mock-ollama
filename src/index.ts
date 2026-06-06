#!/usr/bin/env node
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { loadEnvFile } from "node:process";
import yargs from "yargs";
import { hideBin } from "yargs/helpers";
import { name } from "../package.json";
import { Utils } from "./utils";

// SSE 客户端管理
const sseClients = new Set<{ write: (data: string) => void }>();

function broadcastToSseClients(event: string, data: unknown) {
    const message = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const client of sseClients) {
        try {
            client.write(message);
        } catch {
            sseClients.delete(client);
        }
    }
}

// 从当前工作目录加载 .env（Node 20.12+ 内置，无额外依赖）
if (existsSync(".env")) {
    loadEnvFile();
}

type ProviderName = string;
type AgentApiConfig = {
    chat: string;
    tags: string;
}
type ProviderPreset = {
    matchStr: string;
    apiPath: AgentApiConfig;
}
type ProviderPresetMap = Record<string, ProviderPreset>;
type ProviderConfig = {
    name: ProviderName;
    baseUrl: string;
    apikey: string;
    apiPath: AgentApiConfig | null;
}

type LogEntry = {
    id: number;
    time: string;
    method: string;
    path: string;
    model?: string;
    duration?: number;
    status?: number;
    error?: string;
    request?: unknown;
    response?: unknown;
}

type RequestLogContext = {
    id: number;
    startTime: number;
    model?: string;
}

// 内存日志存储（环形缓冲区，保留最近 200 条）
const MAX_LOG_ENTRIES = 200;
const logEntries: LogEntry[] = [];
let logIdCounter = 0;

function addLogEntry(entry: Omit<LogEntry, 'id'>): LogEntry {
    const fullEntry: LogEntry = { ...entry, id: ++logIdCounter };
    logEntries.push(fullEntry);
    if (logEntries.length > MAX_LOG_ENTRIES) {
        logEntries.shift();
    }
    // SSE 推送新日志
    broadcastToSseClients('new-log', fullEntry);
    return fullEntry;
}

function getLogEntries(limit: number = 100): LogEntry[] {
    return logEntries.slice(-limit);
}

let G_ProviderConfig : ProviderConfig = {
    name: "unknown",
    baseUrl: "",
    apikey: "",
    apiPath: null,
}

const PROVIDER_PRESET_MAP: ProviderPresetMap = {
    "anthropic": {
        matchStr: "api.anthropic.com",
        apiPath: { chat: "/v1/messages", tags: "/models" },
    },
    "mock-anthropic": {
        matchStr: "/anthropic",
        apiPath: { chat: "/v1/messages", tags: "/v1/models" },
    },
    "zhipu": {
        matchStr: "bigmodel.cn",
        apiPath: { chat: "/chat/completions", tags: "/models" },
    },
    "deepseek": {
        matchStr: "api.deepseek.com",
        apiPath: { chat: "/chat/completions", tags: "/models" },
    },
     "BaiLian": {
        matchStr: "dashscope.aliyuncs.com",
        apiPath: { chat: "/chat/completions", tags: "/models" },
    },
};

function processProviderName(baseUrl: string): ProviderName {
    for (const [providerName, providerPreset] of Object.entries(PROVIDER_PRESET_MAP)) {
        if (baseUrl.includes(providerPreset.matchStr)) {
            return providerName as ProviderName;
        }
    }
    return "unknown";
}
function processApiPath(providerName: ProviderName): AgentApiConfig | null {
    return PROVIDER_PRESET_MAP[providerName]?.apiPath ?? null;
}

function buildRequestHeaders(headers: HeadersInit) {
    const requestHeaders = new Headers(headers);
    requestHeaders.delete("authorization");
    requestHeaders.delete("content-length");
    requestHeaders.set("Authorization", `Bearer ${G_ProviderConfig.apikey}`);
    requestHeaders.set("x-api-key", G_ProviderConfig.apikey); // anthropic 兼容接口
    return requestHeaders;
}
function buildResponseHeaders(headers: HeadersInit) {
    const responseHeaders = new Headers(headers);
    responseHeaders.delete("content-encoding");
    responseHeaders.delete("transfer-encoding");
    return responseHeaders;
}
async function readRequestBodyForLog(request: Request) {
    const contentType = request.headers.get("content-type");
    const rawText = await request.clone().text();
    if (rawText.length === 0) {
        return null;
    }
    return Utils.responseBodyForLog(rawText, contentType);
}
async function proxyChatRequest(c: any, routePath: string) {
    const startTime = Date.now();
    const timeNow = Utils.timeNow();
    const body = await c.req.json();
    const chooseModel = body.model ?? "unknown";

    console.log(`[${timeNow}] [请求] POST ${routePath} from model ${chooseModel}`);

    const logCtx: RequestLogContext = { id: logIdCounter + 1, startTime, model: chooseModel };

    try {
        const realRequestUrl = `${G_ProviderConfig.baseUrl}${G_ProviderConfig.apiPath?.chat}`;
        const headers = buildRequestHeaders(c.req.raw.headers);

        Utils.dumpObject("发送请求", { url: realRequestUrl, method: "POST", headers: headers, body: body });
        const res = await fetch(realRequestUrl, {
            method: "POST",
            headers: headers,
            body: JSON.stringify(body),
        });
        console.log(`[${Utils.timeNow()}] [上游响应] status=${res.status}`);
        const contentType = res.headers.get("content-type");
        const responseHeaders = buildResponseHeaders(res.headers);

        if (Utils.isSseContentType(contentType) && res.body) { // SSE 响应处理
            const [clientBody, logBody] = res.body.tee();
            const duration = Date.now() - startTime;

            void Utils.readStreamToText(logBody)
                .then((rawText) => {
                    const responseBody = Utils.responseBodyForLog(rawText, contentType);
                    Utils.dumpObject("请求回应", {
                        status: res.status,
                        headers: res.headers,
                        body: responseBody,
                    });
                    addLogEntry({
                        time: timeNow,
                        method: "POST",
                        path: routePath,
                        model: chooseModel,
                        duration,
                        status: res.status,
                        request: { model: chooseModel, messages: body.messages },
                        response: responseBody,
                    });
                })
                .catch((error) => {
                    console.error(`[${Utils.timeNow()}] [错误] SSE 日志读取失败:`, error);
                    addLogEntry({
                        time: timeNow,
                        method: "POST",
                        path: routePath,
                        model: chooseModel,
                        duration: Date.now() - startTime,
                        status: res.status,
                        request: { model: chooseModel, messages: body.messages },
                        error: String(error),
                    });
                });

            console.log(`[${Utils.timeNow()}] [响应] ${routePath} (耗时: ${duration}ms)`);
            return new Response(clientBody, {
                status: res.status,
                headers: responseHeaders,
            });
        }

        // 非 SSE 响应处理
        const rawText = await res.clone().text();
        const responseBody = Utils.responseBodyForLog(rawText, contentType);
        const duration = Date.now() - startTime;
        Utils.dumpObject("请求回应", {
            status: res.status,
            headers: res.headers,
            body: responseBody,
        });
        console.log(`[${Utils.timeNow()}] [响应] ${routePath} (耗时: ${duration}ms)`);

        addLogEntry({
            time: timeNow,
            method: "POST",
            path: routePath,
            model: chooseModel,
            duration,
            status: res.status,
            request: { model: chooseModel, messages: body.messages },
            response: responseBody,
        });

        return new Response(res.body, {
            status: res.status,
            headers: responseHeaders,
        });

    } catch (e) {
        const duration = Date.now() - startTime;
        console.error(`[${Utils.timeNow()}] [错误] 请求发生异常:`, e);
        addLogEntry({
            time: timeNow,
            method: "POST",
            path: routePath,
            model: chooseModel,
            duration,
            status: 500,
            request: { model: chooseModel, messages: body.messages },
            error: String(e),
        });
        return c.json({ error: String(e) }, 500);
    }
}

// HTML 页面路径（每次请求时动态读取，方便开发调试）
const pageHtmlPath = join(__dirname, "page.html");
function getPageHtml(): string {
    try {
        return readFileSync(pageHtmlPath, "utf-8");
    } catch (e) {
        console.error(`无法读取页面文件: ${pageHtmlPath}`);
        return "<html><body><h1>页面加载失败</h1></body></html>";
    }
}

// 代理服务
const app = new Hono();
app.get("/", (c) => c.html(getPageHtml()));
app.get("/api/version", (c) => c.json({ version: "0.18.2", from: name }));

// 获取服务配置信息（供前端页面使用）
app.get("/api/info", (c) => c.json({
    provider: G_ProviderConfig.name,
    baseUrl: G_ProviderConfig.baseUrl,
    apiKeyMasked: Utils.maskSecret(G_ProviderConfig.apikey),
}));

// 获取请求日志
app.get("/api/logs", (c) => {
    const limit = parseInt(c.req.query("limit") || "100", 10);
    return c.json(getLogEntries(limit));
});

// 清空日志
app.delete("/api/logs", (c) => {
    logEntries.length = 0;
    logIdCounter = 0;
    // SSE 推送清空通知
    broadcastToSseClients('clear-logs', { ok: true });
    return c.json({ ok: true, message: "日志已清空" });
});

// SSE 实时推送日志
app.get("/api/logs/stream", (c) => {
    const stream = new ReadableStream({
        start(controller) {
            const encoder = new TextEncoder();
            const client = {
                write: (data: string) => {
                    try {
                        controller.enqueue(encoder.encode(data));
                    } catch {
                        sseClients.delete(client);
                    }
                }
            };
            sseClients.add(client);

            // 发送初始连接成功消息
            controller.enqueue(encoder.encode(': connected\n\n'));
        },
        cancel() {
            // 客户端断开时清理
            for (const client of sseClients) {
                sseClients.delete(client);
            }
        }
    });

    return new Response(stream, {
        headers: {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive',
        },
    });
});

app.post("/api/show", async (c) => {
    try {
        const body = await c.req.json();
        const model = body.model ?? body.name ?? "unknown";
        const modelInfo = {
            model_info: {
                "general.architecture": model,
                [`${model}.context_length`]: 200_000, // 200k
            },
            "capabilities":["completion", "vision", "tools", "thinking"],
        }
        return c.json(modelInfo);
    } catch (e) {
        console.error(`[${Utils.timeNow()}] [错误] 请求发生异常:`, e);
        return c.json({ error: String(e) }, 500);
    }
});

app.get("/api/tags", async (c) => {
    // 从配置中获取 tags 端点路径
    const startTime = Date.now();
    const timeNow = Utils.timeNow();
    const headers = new Headers({
        "Authorization": `Bearer ${G_ProviderConfig.apikey}`,
        "Content-Type": "application/json",
    });
    try {
        console.log(`[${timeNow}] [请求] GET /api/tags`);
        const realRequestUrl = `${G_ProviderConfig.baseUrl}${G_ProviderConfig.apiPath?.tags}`;
        Utils.dumpObject("发送请求", { url: realRequestUrl, method: "GET", headers: headers});

        const res = await fetch(realRequestUrl, {
            method: "GET",
            headers: headers,
        });
        console.log(`[${Utils.timeNow()}] [上游响应] status=${res.status}`);

        const models: { name: string; model: string }[] = [];
        let responseBody: unknown = null;
        if (res.ok) {
            const data = await res.json();
            responseBody = data;
            Utils.dumpObject("请求回应", { status: res.status, headers: res.headers, body: data });
            // OpenAI 格式: data.data = [{id: "model-name"}]
            // Anthropic 格式: data.models = [{id: "model-name"}]
            const items = data.data || data.models || [];
            for (const item of items) {
                const modelId = item.id;
                if (modelId) {
                    models.push({
                        name: modelId,
                        model: modelId,
                    });
                }
            }
        }
        const duration = Date.now() - startTime;
        console.log(`[${Utils.timeNow()}] [响应] /api/tags (耗时: ${duration}ms)`);
        addLogEntry({
            time: timeNow,
            method: "GET",
            path: "/api/tags",
            duration,
            status: res.status,
            response: responseBody ?? { models: models },
        });
        return c.json({ models: models });

    } catch (e) {
        const duration = Date.now() - startTime;
        console.error(`[${Utils.timeNow()}] [错误] 请求发生异常:`, e);
        addLogEntry({
            time: timeNow,
            method: "GET",
            path: "/api/tags",
            duration,
            status: 500,
            error: String(e),
        });
        return c.json({ error: String(e) }, 500);
    }
});

app.post("/chat/completions", async (c) => {
    return proxyChatRequest(c, "/chat/completions");
});
app.post("/v1/chat/completions", async (c) => {
    return proxyChatRequest(c, "/v1/chat/completions");
});
app.post("/v1/messages", async (c) => {
    return proxyChatRequest(c, "/v1/messages");
});
app.all("*", async (c) => {
    const requestInfo = {
        method: c.req.method,
        path: c.req.path,
        query: c.req.query(),
        headers: c.req.raw.headers,
        body: await readRequestBodyForLog(c.req.raw),
    };
    Utils.dumpObject("收到未知请求", requestInfo);
    return c.json({
        ok: false,
        error: "收到未匹配路由请求",
    }, 404);
});

// 主函数：解析参数并启动服务器
async function main() {
    const providerPresetDemo = [
        "\n环境变量配置示例:",
`export MOCK_OLLAMA_BASE_URL="https://open.bigmodel.cn/api/paas/v4"`,
`export MOCK_OLLAMA_API_KEY="your-api-key"`,
`export MOCK_OLLAMA_PROVIDER_PRESET='{
    "my-glm": {
        "matchStr": "bigmodel.cn",
            "apiPath": {
            "chat": "/chat/completions",
            "tags": "/models"
        }
    }
}'`,
    "\n请求示例:",
    `1. curl http://localhost:11434/api/version`,
    `2. curl http://localhost:11434/api/tags`,
    `3. curl -X POST http://localhost:11434/chat/completions -H "Content-Type: application/json" -d '{"model": "glm-4.7", "messages": [{"role": "user", "content": "你是谁？"}]}'`,
    ].join("\n");
    const cli = await yargs(hideBin(process.argv))
            .usage('Usage: mock-ollama [command] <options>') 
            .scriptName("mock-ollama")
            .alias("v", "version")
            .alias("h", "help")
            .alias("q", "quiet")
            .option("port", {
                type: "number",
                description: "模拟 ollama server port",
            })
            .option("host", {
                type: "string",
                description: "模拟 ollama server host",
            })
            .option("apikey", {
                type: "string",
                description: "上游服务商 apikey，或者export MOCK_OLLAMA_API_KEY",
            })
            .option("url", {
                type: "string",
                description: "上游服务商 url，或者export MOCK_OLLAMA_BASE_URL",
            })
            .option("provider-preset", {
                type: "string",
                description: "额外 provider JSON配置，或者 export MOCK_OLLAMA_PROVIDER_PRESET",
            })
            .option("quiet", {
                type: "boolean",
                description: "安静模式",
            })
            .epilog(providerPresetDemo)
            .parse();
    const port = cli.port ?? 11434;
    const host = cli.host ?? "localhost";
    Utils.setObjectDumpQuiet(cli.quiet ?? false);
    serve(
        {
            fetch: app.fetch,
            hostname: host,
            port: port,
        },
        (info) => {
            console.log(`模拟服务启动在 http://${info.address}:${info.port}`);
        },
    );


    G_ProviderConfig.baseUrl = cli.url ?? process.env.MOCK_OLLAMA_BASE_URL ?? "";
    G_ProviderConfig.apikey = cli.apikey ?? process.env.MOCK_OLLAMA_API_KEY ?? "";
    Utils.mergeProviderPresetMap(PROVIDER_PRESET_MAP, cli.providerPreset ?? process.env.MOCK_OLLAMA_PROVIDER_PRESET);

    if (G_ProviderConfig.baseUrl.length === 0 || G_ProviderConfig.apikey.length === 0) {
        console.error("上游服务商配置错误，请检查命令行参数或环境变量");
        console.error("你可以通过命令行参数 --url 和 --apikey 设置");
        console.error("也可以环境变量 MOCK_OLLAMA_BASE_URL 和 MOCK_OLLAMA_API_KEY 设置");
        process.exit(1);
    }
    else {
        if (G_ProviderConfig.baseUrl.endsWith("/")) {// 去除末尾斜杠
            G_ProviderConfig.baseUrl = G_ProviderConfig.baseUrl.slice(0, -1);
        }
    }

    G_ProviderConfig.name = processProviderName(G_ProviderConfig.baseUrl);
    G_ProviderConfig.apiPath = processApiPath(G_ProviderConfig.name);
    console.log(`上游服务商配置:\n${G_ProviderConfig.name}, ${G_ProviderConfig.baseUrl}, ${Utils.maskSecret(G_ProviderConfig.apikey)}`);
    Utils.dumpObject("ApiPathConfig", G_ProviderConfig.apiPath);
}

// 启动入口
main().catch((err) => {
    console.error("服务启动报错:", err);
    process.exit(1);
});
  