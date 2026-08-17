import { createHash } from "node:crypto";
import { object, type JsonObject } from "./bridge/types";
import type { ApiFormat } from "./bridge/matrix";

export type UpstreamConfig = {
    baseUrl: string;
    apikey: string;
    apiStyle?: "auto" | ApiFormat;
};

export type UpstreamPostOptions = {
    allowDownstreamStream?: boolean;
    anthropicVersion?: string | null;
    inboundPromptCacheKey?: string | null;
};

export type UpstreamResult = {
    response: Response;
    isSse: boolean;
    streamDowngraded: boolean;
};

export class UpstreamError extends Error {
    constructor(
        readonly status: number,
        readonly body: unknown,
        readonly response?: Response,
        readonly original?: unknown,
        readonly raw = "",
    ) {
        super(original instanceof Error ? original.message : String(original ?? (raw || "Upstream request failed")));
        this.name = "UpstreamError";
    }
}

function errorBody(raw: string): unknown {
    if (raw === "") return { message: "Upstream request failed" };
    try {
        return JSON.parse(raw);
    } catch {
        return { message: raw };
    }
}

export async function isSseResponse(response: Response, probeSseBody = false): Promise<{ response: Response; isSse: boolean }> {
    const contentType = (response.headers.get("content-type") ?? "").toLowerCase();
    if (contentType.includes("text/event-stream")) return { response, isSse: true };
    if (!probeSseBody || contentType.includes("application/json") || !response.body) return { response, isSse: false };

    const [probe, body] = response.body.tee();
    const reader = probe.getReader();
    const firstChunk = await reader.read();
    void reader.cancel();
    const prefix = new TextDecoder().decode(firstChunk.value).trimStart();
    return {
        response: new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers }),
        isSse: prefix.startsWith("event:") || prefix.startsWith("data:"),
    };
}

export function upstreamRequest(config: UpstreamConfig, path: string, init: RequestInit): Promise<Response> {
    return fetch(`${config.baseUrl}${path}`, init);
}

/** Responses 的 session-id 由 bridge 基于上游地址稳定生成，不透传入站客户端会话标识。 */
function stableResponsesSessionId(config: UpstreamConfig): string {
    const namespace = Buffer.from("6ba7b8129dad11d180b400c04fd430c8", "hex");
    const name = `mock-ollama:responses:session:${config.baseUrl}`;
    const hash = createHash("sha1").update(namespace).update(name).digest();
    hash[6] = (hash[6] & 0x0f) | 0x50;
    hash[8] = (hash[8] & 0x3f) | 0x80;
    const hex = hash.subarray(0, 16).toString("hex");
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** bridge 的 Responses 请求补充会话关联 header。 */
function responsesBridgeHeaders(sessionId: string, apikey: string): Record<string, string> {
    const windowId = `${sessionId}:0`;
    return {
        "x-openai-actor-authorization": `Bearer ${apikey}`,
        "x-codex-beta-features": "remote_compaction_v2",
        "x-codex-window-id": windowId,
        "x-codex-turn-metadata": JSON.stringify({
            session_id: sessionId,
            thread_id: sessionId,
            window_id: windowId,
            request_kind: "turn",
        }),
        "originator": "codex_exec",
        "session-id": sessionId,
        "thread-id": sessionId,
        "x-client-request-id": sessionId,
        "x-openai-internal-codex-responses-lite": "true",
    };
}

export function upstreamClient(config: UpstreamConfig) {
    return {
        async post(path: string, body: JsonObject, options: UpstreamPostOptions = {}): Promise<UpstreamResult> {
            const payload = { ...body };
            const streamDowngraded = payload.stream === true && options.allowDownstreamStream === false;
            if (streamDowngraded) {
                delete payload.stream;
                delete payload.stream_options;
            }

            const isAnthropic = path === "/v1/messages";
            const isResponses = path === "/v1/responses";
            const responsesBridge = isResponses && config.apiStyle === "responses";
            const sessionId = options.inboundPromptCacheKey || stableResponsesSessionId(config);
            const responsesHeaders = responsesBridge ? responsesBridgeHeaders(sessionId, config.apikey) : {};
            if (responsesBridge) {
                payload.stream = true;
                delete payload.max_output_tokens;
                payload.store = false;
                payload.prompt_cache_key = sessionId;
            }
            let response: Response;
            try {
                response = await upstreamRequest(config, path, {
                    method: "POST",
                    headers: {
                        "content-type": "application/json",
                        "authorization": `Bearer ${config.apikey}`,
                        ...(isAnthropic ? {
                            "x-api-key": config.apikey,
                            "anthropic-version": options.anthropicVersion ?? "2023-06-01",
                        } : {}),
                        ...responsesHeaders,
                    },
                    body: JSON.stringify(payload),
                });
            } catch (error) {
                throw new UpstreamError(502, { message: String(error) }, undefined, error);
            }

            if (!response.ok) {
                const raw = await response.text();
                throw new UpstreamError(response.status, errorBody(raw), response, undefined, raw);
            }
            const sse = await isSseResponse(response, responsesBridge);
            return { response: sse.response, isSse: sse.isSse, streamDowngraded };
        },
    };
}
