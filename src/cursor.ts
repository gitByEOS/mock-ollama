import { createHash, timingSafeEqual } from "node:crypto";
import { Hono } from "hono";

const HOP_BY_HOP_HEADERS = new Set([
    "connection",
    "keep-alive",
    "proxy-authenticate",
    "proxy-authorization",
    "te",
    "trailer",
    "transfer-encoding",
    "upgrade",
]);

const MAX_BODY_BYTES = 16 * 1024 * 1024;

export type CursorModel = Readonly<{ id: string }>;

export type CursorProxyOptions = Readonly<{
    apiKey: string;
    upstreamBaseUrl: string;
    models: ReadonlyArray<CursorModel>;
}>;

function cursorError(message: string, status: number) {
    return {
        error: {
            message,
            type: status === 401 ? "authentication_error" : "invalid_request_error",
            param: null,
            code: status === 401 ? "invalid_api_key" : null,
        },
    };
}

function equalSecrets(left: string, right: string): boolean {
    // 用 hash 消除长度信息泄漏，比较耗时与输入长度无关
    const leftHash = createHash("sha256").update(left).digest();
    const rightHash = createHash("sha256").update(right).digest();
    return timingSafeEqual(leftHash, rightHash);
}

function hasValidBearer(request: Request, apiKey: string): boolean {
    const authorization = request.headers.get("authorization") ?? "";
    const match = /^Bearer\s+(.+)$/i.exec(authorization);
    return match !== null && equalSecrets(match[1].trim(), apiKey);
}

function isAllowedModel(requestedModel: unknown, models: ReadonlyArray<CursorModel>): requestedModel is string {
    if (typeof requestedModel !== "string") return false;
    return models.some((m) => m.id === requestedModel);
}

function cleanResponseHeaders(headers: Headers): Headers {
    const result = new Headers(headers);
    for (const header of HOP_BY_HOP_HEADERS) result.delete(header);
    result.delete("content-length");
    return result;
}

async function readJsonBody(request: Request): Promise<Record<string, unknown> | null> {
    const contentLength = Number(request.headers.get("content-length") ?? "0");
    if (contentLength > MAX_BODY_BYTES) return null;
    if (!request.body) return null;
    const reader = request.body.getReader();
    let received = 0;
    const chunks: Uint8Array[] = [];
    try {
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            received += value.byteLength;
            if (received > MAX_BODY_BYTES) return null;
            chunks.push(value);
        }
    } finally {
        reader.releaseLock();
    }
    try {
        const parsed = JSON.parse(new TextDecoder().decode(Buffer.concat(chunks)));
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
        return parsed as Record<string, unknown>;
    } catch {
        return null;
    }
}

async function forwardChatRequest(request: Request, options: CursorProxyOptions): Promise<Response> {
    const body = await readJsonBody(request);
    if (body === null) {
        return Response.json(cursorError("Request body must be valid JSON under 16MB", 400), { status: 400 });
    }

    if (!isAllowedModel(body.model, options.models)) {
        const allowed = options.models.map((m) => m.id).join(", ");
        return Response.json(cursorError(`Unknown model "${String(body.model ?? "")}". Allowed: ${allowed}`, 400), { status: 400 });
    }

    // 用独立 AbortController 把下游断开传播到上游 fetch，覆盖响应体流式阶段
    const abortController = new AbortController();
    const onClientAbort = () => abortController.abort();
    request.signal.addEventListener("abort", onClientAbort, { once: true });

    const headers = new Headers();
    headers.set("content-type", "application/json");
    headers.set("accept", request.headers.get("accept") ?? "application/json");
    let response: Response;
    try {
        response = await fetch(`${options.upstreamBaseUrl}/v1/chat/completions`, {
            method: "POST",
            headers,
            body: JSON.stringify(body),
            signal: abortController.signal,
        });
    } catch (error) {
        request.signal.removeEventListener("abort", onClientAbort);
        throw new Error(`Local mock-ollama is unavailable: ${String(error)}`);
    }

    const headersOut = cleanResponseHeaders(response.headers);
    const isSse = headersOut.get("content-type")?.toLowerCase().includes("text/event-stream") ?? false;
    if (isSse && response.body) {
        // 下游 cancel response.body 会传播到上游 fetch 的 socket；abortController 处理客户端断开
        return new Response(response.body, {
            status: response.status,
            statusText: response.statusText,
            headers: headersOut,
        });
    }

    const responseBody = await response.text();
    request.signal.removeEventListener("abort", onClientAbort);
    return new Response(responseBody, {
        status: response.status,
        statusText: response.statusText,
        headers: headersOut,
    });
}

/**
 * 仅暴露 Cursor BYOK 所需路由的公网入口。
 * 管理界面、日志与其他协议端点必须继续留在主服务的 loopback 端口。
 */
export function createCursorApp(options: CursorProxyOptions) {
    const app = new Hono();

    app.get("/healthz", (c) => c.json({ ok: true }));

    app.use("/v1/*", async (c, next) => {
        if (!hasValidBearer(c.req.raw, options.apiKey)) {
            return c.json(cursorError("Invalid API key", 401), 401);
        }
        return next();
    });

    app.get("/v1/models", (c) => c.json({
        object: "list",
        data: options.models.map((m) => ({
            id: m.id,
            object: "model",
            created: 0,
            owned_by: "mock-ollama",
        })),
    }));

    app.post("/v1/chat/completions", async (c) => {
        try {
            return await forwardChatRequest(c.req.raw, options);
        } catch (error) {
            return c.json(cursorError(error instanceof Error ? error.message : String(error), 502), 502);
        }
    });

    app.all("*", (c) => c.json(cursorError("Not found", 404), 404));
    return app;
}
