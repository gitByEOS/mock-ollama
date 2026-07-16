import { Hono } from "hono";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { name } from "../package.json";
import { dispatchMatrix as conversionMatrix, runConversion, type ApiFormat, type ConversionPair } from "./bridge/matrix";
import { addLogEntry, clearLogEntries, getLogEntries, sseClients } from "./log_store";
import { createProviderContext, type ProviderContext } from "./provider";
import { upstreamClient, upstreamRequest } from "./upstream";
import {
    dumpObject,
    isSseContentType,
    maskSecret,
    readStreamToText,
    responseBodyForLog,
    timeNow as currentTime,
} from "./utils";

function buildRequestHeaders(headers: HeadersInit, context: ProviderContext) {
    const requestHeaders = new Headers(headers);
    requestHeaders.delete("authorization");
    requestHeaders.delete("content-length");
    requestHeaders.set("Authorization", `Bearer ${context.config.apikey}`);
    requestHeaders.set("x-api-key", context.config.apikey); // anthropic 兼容接口
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
    return responseBodyForLog(rawText, contentType);
}
async function proxyChatRequest(c: any, routePath: string, context: ProviderContext, upstreamPath?: string) {
    const startTime = Date.now();
    const timeNow = currentTime();
    const body = await c.req.json();
    const chooseModel = body.model ?? "unknown";

    console.log(`[${timeNow}] [请求] POST ${routePath} from model ${chooseModel}`);


    try {
        const path = upstreamPath ?? context.config.apiPath.chat;
        const realRequestUrl = `${context.config.baseUrl}${path}`;
        const headers = buildRequestHeaders(c.req.raw.headers, context);

        dumpObject("发送请求", { url: realRequestUrl, method: "POST", headers: headers, body: body });
        const res = await upstreamRequest(context.config, path, {
            method: "POST",
            headers: headers,
            body: JSON.stringify(body),
        });
        console.log(`[${currentTime()}] [上游响应] status=${res.status}`);
        const contentType = res.headers.get("content-type");
        const responseHeaders = buildResponseHeaders(res.headers);

        if (isSseContentType(contentType) && res.body) { // SSE 响应处理
            const [clientBody, logBody] = res.body.tee();
            const duration = Date.now() - startTime;

            void readStreamToText(logBody)
                .then((rawText) => {
                    const responseBody = responseBodyForLog(rawText, contentType);
                    dumpObject("请求回应", {
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
                        request: body,
                        response: responseBody,
                    });
                })
                .catch((error) => {
                    console.error(`[${currentTime()}] [错误] SSE 日志读取失败:`, error);
                    addLogEntry({
                        time: timeNow,
                        method: "POST",
                        path: routePath,
                        model: chooseModel,
                        duration: Date.now() - startTime,
                        status: res.status,
                        request: body,
                        error: String(error),
                    });
                });

            console.log(`[${currentTime()}] [响应] ${routePath} (耗时: ${duration}ms)`);
            return new Response(clientBody, {
                status: res.status,
                headers: responseHeaders,
            });
        }

        // 非 SSE 响应处理
        const rawText = await res.clone().text();
        const responseBody = responseBodyForLog(rawText, contentType);
        const duration = Date.now() - startTime;
        dumpObject("请求回应", {
            status: res.status,
            headers: res.headers,
            body: responseBody,
        });
        console.log(`[${currentTime()}] [响应] ${routePath} (耗时: ${duration}ms)`);

        addLogEntry({
            time: timeNow,
            method: "POST",
            path: routePath,
            model: chooseModel,
            duration,
            status: res.status,
            request: body,
            response: responseBody,
        });

        return new Response(res.body, {
            status: res.status,
            headers: responseHeaders,
        });

    } catch (e) {
        const duration = Date.now() - startTime;
        console.error(`[${currentTime()}] [错误] 请求发生异常:`, e);
        addLogEntry({
            time: timeNow,
            method: "POST",
            path: routePath,
            model: chooseModel,
            duration,
            status: 500,
            request: body,
            error: String(e),
        });
        return c.json({ error: String(e) }, 500);
    }
}

async function convertedRequestWithLog(
    c: any,
    routePath: string,
    handler: (request: Request) => Promise<Response>,
) {
    const startTime = Date.now();
    const timeNow = currentTime();
    const request = c.req.raw as Request;
    const requestBody = await readRequestBodyForLog(request);
    const model = objectModel(requestBody);
    console.log(`[${timeNow}] [请求] POST ${routePath} from model ${model}`);
    try {
        const response = await handler(request);
        const contentType = response.headers.get("content-type");
        if (isSseContentType(contentType) && response.body) {
            const [clientBody, logBody] = response.body.tee();
            void readStreamToText(logBody).then((rawText) => {
                addLogEntry({
                    time: timeNow,
                    method: "POST",
                    path: routePath,
                    model,
                    duration: Date.now() - startTime,
                    status: response.status,
                    request: requestBody,
                    response: responseBodyForLog(rawText, contentType),
                });
            }).catch((error) => {
                console.error(`[${currentTime()}] [错误] SSE 日志读取失败:`, error);
            });
            return new Response(clientBody, {
                status: response.status,
                headers: response.headers,
            });
        }
        const rawText = await response.clone().text();
        addLogEntry({
            time: timeNow,
            method: "POST",
            path: routePath,
            model,
            duration: Date.now() - startTime,
            status: response.status,
            request: requestBody,
            response: responseBodyForLog(rawText, contentType),
        });
        return response;
    } catch (error) {
        addLogEntry({
            time: timeNow,
            method: "POST",
            path: routePath,
            model,
            duration: Date.now() - startTime,
            status: 500,
            request: requestBody,
            error: String(error),
        });
        return c.json({ error: String(error) }, 500);
    }
}

function objectModel(body: unknown): string {
    if (!body || typeof body !== "object" || Array.isArray(body)) return "unknown";
    const model = (body as Record<string, unknown>).model;
    return typeof model === "string" ? model : "unknown";
}

type MatrixHandler = (c: any, routePath: string) => Promise<Response>;

function conversionConfig(context: ProviderContext) {
    return {
        baseUrl: context.config.baseUrl,
        apikey: context.config.apikey,
        apiStyle: context.upstreamFormat,
    };
}

function convertedHandler(pair: ConversionPair, context: ProviderContext): MatrixHandler {
    return (c, routePath) => convertedRequestWithLog(
        c,
        routePath,
        (request) => runConversion(request, upstreamClient(conversionConfig(context)), pair),
    );
}

/** 入站格式 × 上游格式的 3×3 handler 查找表。 */
export function createDispatchMatrix(context: ProviderContext): Record<ApiFormat, Record<ApiFormat, MatrixHandler>> {
    const handler = (pair: ConversionPair) => convertedHandler(pair, context);
    return {
        anthropic: {
            anthropic: handler(conversionMatrix.anthropic.anthropic),
            responses: handler(conversionMatrix.anthropic.responses),
            chat: handler(conversionMatrix.anthropic.chat),
        },
        responses: {
            anthropic: handler(conversionMatrix.responses.anthropic),
            responses: handler(conversionMatrix.responses.responses),
            chat: handler(conversionMatrix.responses.chat),
        },
        chat: {
            anthropic: handler(conversionMatrix.chat.anthropic),
            responses: handler(conversionMatrix.chat.responses),
            chat: handler(conversionMatrix.chat.chat),
        },
    };
}

async function dispatchProtocolRequest(
    c: any,
    routePath: string,
    inbound: ApiFormat,
    context: ProviderContext,
    matrix: Record<ApiFormat, Record<ApiFormat, MatrixHandler>>,
) {
    // 关闭 bridge 时是低开销原样代理，端点路径和请求/响应体都不改写。
    if (!context.bridge) return proxyChatRequest(c, routePath, context, routePath);
    return matrix[inbound][context.upstreamFormat](c, routePath);
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
export function createApp(context: ProviderContext) {
const dispatchMatrix = createDispatchMatrix(context);
const app = new Hono();
app.get("/", (c) => c.html(getPageHtml()));
app.get("/api/version", (c) => c.json({ version: "0.18.2", from: name }));

// 获取服务配置信息（供前端页面使用）
app.get("/api/info", (c) => c.json({
    provider: context.config.name,
    baseUrl: context.config.baseUrl,
    apiKeyMasked: maskSecret(context.config.apikey),
    apiStyle: context.config.apiStyle,
    upstreamFormat: context.upstreamFormat,
    bridge: context.bridge,
    contextLength: context.contextLength,
}));

// 获取请求日志
app.get("/api/logs", (c) => {
    const limit = parseInt(c.req.query("limit") || "100", 10);
    return c.json(getLogEntries(limit));
});

// 清空日志
app.delete("/api/logs", (c) => {
    clearLogEntries();
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
                [`${model}.context_length`]: context.contextLength,
            },
            "capabilities":["completion", "vision", "tools", "thinking"],
        }
        return c.json(modelInfo);
    } catch (e) {
        console.error(`[${currentTime()}] [错误] 请求发生异常:`, e);
        return c.json({ error: String(e) }, 500);
    }
});

app.get("/api/tags", async (c) => {
    // 从配置中获取 tags 端点路径
    const startTime = Date.now();
    const timeNow = currentTime();
    const headers = new Headers({
        "Authorization": `Bearer ${context.config.apikey}`,
        "Content-Type": "application/json",
    });
    try {
        console.log(`[${timeNow}] [请求] GET /api/tags`);
        const realRequestUrl = `${context.config.baseUrl}${context.config.apiPath.tags}`;
        dumpObject("发送请求", { url: realRequestUrl, method: "GET", headers: headers});

        const res = await upstreamRequest(context.config, context.config.apiPath.tags, {
            method: "GET",
            headers: headers,
        });
        console.log(`[${currentTime()}] [上游响应] status=${res.status}`);

        const models: { name: string; model: string }[] = [];
        let responseBody: unknown = null;
        if (res.ok) {
            const data = await res.json();
            responseBody = data;
            dumpObject("请求回应", { status: res.status, headers: res.headers, body: data });
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
        console.log(`[${currentTime()}] [响应] /api/tags (耗时: ${duration}ms)`);
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
        console.error(`[${currentTime()}] [错误] 请求发生异常:`, e);
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

app.post("/chat/completions", (c) => dispatchProtocolRequest(c, "/chat/completions", "chat", context, dispatchMatrix));
app.post("/v1/chat/completions", (c) => dispatchProtocolRequest(c, "/v1/chat/completions", "chat", context, dispatchMatrix));
app.post("/v1/messages", (c) => dispatchProtocolRequest(c, "/v1/messages", "anthropic", context, dispatchMatrix));
app.post("/v1/responses", (c) => dispatchProtocolRequest(c, "/v1/responses", "responses", context, dispatchMatrix));
app.all("*", async (c) => {
    const requestInfo = {
        method: c.req.method,
        path: c.req.path,
        query: c.req.query(),
        headers: c.req.raw.headers,
        body: await readRequestBodyForLog(c.req.raw),
    };
    dumpObject("收到未知请求", requestInfo);
    return c.json({
        ok: false,
        error: "收到未匹配路由请求",
    }, 404);
});
return app;
}

const defaultContext = createProviderContext({ baseUrl: "", apikey: "" });
export const dispatchMatrix = createDispatchMatrix(defaultContext);
export const app = createApp(defaultContext);
