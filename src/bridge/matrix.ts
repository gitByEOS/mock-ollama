import {
    anthropicRequestToChat,
    anthropicResponseToChat,
    chatRequestToAnthropic,
    chatResponseToAnthropic,
} from "./anthropic_chat";
import {
    anthropicObjectToChatSse,
    anthropicResponseToSse,
    createAnthropicToChatSseStream,
    createChatToAnthropicSseStream,
} from "./anthropic_chat_sse";
import {
    anthropicRequestToResponses,
    anthropicResponseToResponses,
    responsesRequestToAnthropic,
    responsesResponseToAnthropic,
} from "./anthropic_responses";
import {
    chatRequestToResponses,
    chatResponseToResponses,
    responsesRequestToChat,
    responsesResponseToChat,
} from "./chat_responses";
import {
    chatObjectToResponsesSse,
    createChatToResponsesSseStream,
    createResponsesToChatSseStream,
    materializeChatSse,
    responsesObjectToChatSse,
} from "./chat_responses_sse";
import {
    anthropicObjectToResponsesSse,
    createAnthropicToResponsesSseStream,
    createResponsesToAnthropicSseStream,
    materializeAnthropicSse,
    materializeResponsesSse,
    responsesObjectToAnthropicSse,
} from "./responses_sse";
import {
    ProtocolConversionError,
    anthropicErrorToOpenAi,
    errorMessage,
    openAiErrorToAnthropic,
} from "./errors";
import {
    chatResponseToSse,
    createAnthropicIdentitySseStream,
    createChatIdentitySseStream,
    createResponsesIdentitySseStream,
    responsesResponseToSse,
} from "./responses_sse_common";
import { object, type JsonObject } from "./types";
import { UpstreamError, upstreamClient } from "../upstream";

export type ApiFormat = "anthropic" | "responses" | "chat";
export type UpstreamClient = ReturnType<typeof upstreamClient>;

export type ConversionPair = {
    upstreamPath: string;
    toUpstream: (body: JsonObject) => JsonObject;
    fromUpstream: (body: JsonObject, request: JsonObject) => JsonObject;
    sseFromUpstream?: (source: ReadableStream<Uint8Array>, request: JsonObject) => ReadableStream<Uint8Array>;
    sseToUpstream?: (body: JsonObject, request: JsonObject) => string;
    materialize?: (raw: string, upstreamRequest: JsonObject) => JsonObject;
    acceptsInboundPromptCacheKey?: boolean;
    requestError: (status: number, message: string, field?: string) => JsonObject;
    upstreamError: (status: number, body: unknown) => JsonObject;
};

const responseHeaderNames = ["request-id", "x-request-id", "openai-processing-ms", "anthropic-ratelimit-requests-remaining"];

function responseHeaders(upstream: Response, contentType: string): Headers {
    const headers = new Headers({ "content-type": contentType });
    for (const name of responseHeaderNames) {
        const value = upstream.headers.get(name);
        if (value) headers.set(name, value);
    }
    if (contentType.includes("text/event-stream")) {
        headers.set("cache-control", "no-cache");
        headers.set("connection", "keep-alive");
    }
    return headers;
}

function jsonResponse(body: JsonObject, status: number, upstream?: Response): Response {
    return new Response(JSON.stringify(body), {
        status,
        headers: upstream
            ? responseHeaders(upstream, "application/json; charset=utf-8")
            : { "content-type": "application/json; charset=utf-8" },
    });
}

async function readBody(response: Response): Promise<unknown> {
    const raw = await response.text();
    if (raw === "") return {};
    try {
        return JSON.parse(raw);
    } catch {
        return { message: raw };
    }
}

async function readStream(stream: ReadableStream<Uint8Array>): Promise<string> {
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let output = "";
    try {
        while (true) {
            const result = await reader.read();
            if (result.done) break;
            output += decoder.decode(result.value, { stream: true });
        }
        return output + decoder.decode();
    } finally {
        reader.releaseLock();
    }
}

export async function runConversion(
    request: Request,
    client: UpstreamClient,
    pair: ConversionPair,
    options: { allowDownstreamStream?: boolean } = {},
): Promise<Response> {
    let inbound: JsonObject;
    let upstreamRequest: JsonObject;
    try {
        inbound = object(await request.json()) ?? {};
        upstreamRequest = pair.toUpstream(inbound);
    } catch (error) {
        const detail = error instanceof ProtocolConversionError
            ? error
            : new ProtocolConversionError(error instanceof Error ? error.message : String(error));
        return jsonResponse(pair.requestError(detail.status, detail.message, detail.field), detail.status);
    }

    let upstream: Response;
    let isSse: boolean;
    try {
        const result = await client.post(pair.upstreamPath, upstreamRequest, {
            allowDownstreamStream: options.allowDownstreamStream ?? true,
            anthropicVersion: request.headers.get("anthropic-version"),
            inboundPromptCacheKey: pair.acceptsInboundPromptCacheKey && typeof inbound.prompt_cache_key === "string"
                ? inbound.prompt_cache_key
                : undefined,
        });
        upstream = result.response;
        isSse = result.isSse;
    } catch (error) {
        if (error instanceof UpstreamError) {
            return jsonResponse(pair.upstreamError(error.status, error.body), error.status, error.response);
        }
        return jsonResponse(pair.upstreamError(502, { message: String(error) }), 502);
    }

    const wantsStream = inbound.stream === true;
    if (isSse && upstream.body) {
        if (wantsStream && pair.sseFromUpstream) {
            return new Response(pair.sseFromUpstream(upstream.body, inbound), {
                status: upstream.status,
                headers: responseHeaders(upstream, "text/event-stream; charset=utf-8"),
            });
        }
        if (!wantsStream && pair.materialize) {
            try {
                const body = pair.materialize(await readStream(upstream.body), upstreamRequest);
                return jsonResponse(pair.fromUpstream(body, inbound), upstream.status, upstream);
            } catch (error) {
                return jsonResponse(pair.upstreamError(502, { message: String(error) }), 502, upstream);
            }
        }
        return jsonResponse(pair.upstreamError(502, {
            message: "Streaming upstream response requires stream=true",
        }), 502, upstream);
    }

    const body = object(await readBody(upstream)) ?? {};
    const converted = pair.fromUpstream(body, inbound);
    if (!wantsStream) return jsonResponse(converted, upstream.status, upstream);
    if (!pair.sseToUpstream) {
        return jsonResponse(pair.upstreamError(502, { message: "SSE conversion is unavailable" }), 502, upstream);
    }
    return new Response(pair.sseToUpstream(body, inbound), {
        status: upstream.status,
        headers: responseHeaders(upstream, "text/event-stream; charset=utf-8"),
    });
}

const openAiRequestError = (status: number, message: string, field?: string): JsonObject => ({
    error: { type: "invalid_request_error", message, param: field ?? null },
});
const anthropicRequestError = (status: number, message: string): JsonObject => openAiErrorToAnthropic(status, {
    error: { type: "invalid_request_error", message },
});
const anthropicApiError = (_status: number, body: unknown): JsonObject => ({
    type: "error",
    error: { type: "api_error", message: errorMessage(body, "Upstream request failed") },
});
const identityError = (_status: number, body: unknown): JsonObject => object(body) ?? { error: { message: String(body) } };

export const conversionPairs = {
    "anthropic-anthropic": {
        upstreamPath: "/v1/messages",
        toUpstream: (body: JsonObject) => ({ ...body }),
        fromUpstream: (body: JsonObject) => body,
        sseFromUpstream: createAnthropicIdentitySseStream,
        sseToUpstream: anthropicResponseToSse,
        materialize: materializeAnthropicSse,
        requestError: anthropicRequestError,
        upstreamError: identityError,
    },
    "responses-responses": {
        upstreamPath: "/v1/responses",
        toUpstream: (body: JsonObject) => ({ ...body }),
        fromUpstream: (body: JsonObject) => body,
        sseFromUpstream: createResponsesIdentitySseStream,
        sseToUpstream: responsesResponseToSse,
        materialize: materializeResponsesSse,
        acceptsInboundPromptCacheKey: true,
        requestError: openAiRequestError,
        upstreamError: identityError,
    },
    "chat-chat": {
        upstreamPath: "/v1/chat/completions",
        toUpstream: (body: JsonObject) => ({ ...body }),
        fromUpstream: (body: JsonObject) => body,
        sseFromUpstream: createChatIdentitySseStream,
        sseToUpstream: chatResponseToSse,
        materialize: materializeChatSse,
        requestError: openAiRequestError,
        upstreamError: identityError,
    },
    "anthropic-responses": {
        upstreamPath: "/v1/responses",
        toUpstream: (body: JsonObject) => {
            const converted = anthropicRequestToResponses(body);
            delete converted.store;
            if (typeof body.max_tokens === "number") converted.max_output_tokens = body.max_tokens;
            return converted;
        },
        fromUpstream: responsesResponseToAnthropic,
        sseFromUpstream: createResponsesToAnthropicSseStream,
        sseToUpstream: responsesObjectToAnthropicSse,
        materialize: (raw: string) => materializeResponsesSse(raw),
        requestError: anthropicRequestError,
        upstreamError: openAiErrorToAnthropic,
    },
    "anthropic-chat": {
        upstreamPath: "/v1/chat/completions",
        toUpstream: anthropicRequestToChat,
        fromUpstream: chatResponseToAnthropic,
        sseFromUpstream: createChatToAnthropicSseStream,
        sseToUpstream: (body: JsonObject, request: JsonObject) => anthropicResponseToSse(chatResponseToAnthropic(body, request)),
        materialize: materializeChatSse,
        requestError: anthropicRequestError,
        upstreamError: anthropicApiError,
    },
    "responses-anthropic": {
        upstreamPath: "/v1/messages",
        toUpstream: responsesRequestToAnthropic,
        fromUpstream: anthropicResponseToResponses,
        sseFromUpstream: createAnthropicToResponsesSseStream,
        sseToUpstream: anthropicObjectToResponsesSse,
        materialize: materializeAnthropicSse,
        acceptsInboundPromptCacheKey: true,
        requestError: openAiRequestError,
        upstreamError: anthropicErrorToOpenAi,
    },
    "responses-chat": {
        upstreamPath: "/v1/chat/completions",
        toUpstream: responsesRequestToChat,
        fromUpstream: chatResponseToResponses,
        sseFromUpstream: createChatToResponsesSseStream,
        sseToUpstream: chatObjectToResponsesSse,
        materialize: materializeChatSse,
        acceptsInboundPromptCacheKey: true,
        requestError: openAiRequestError,
        upstreamError: identityError,
    },
    "chat-anthropic": {
        upstreamPath: "/v1/messages",
        toUpstream: chatRequestToAnthropic,
        fromUpstream: anthropicResponseToChat,
        sseFromUpstream: createAnthropicToChatSseStream,
        sseToUpstream: anthropicObjectToChatSse,
        materialize: materializeAnthropicSse,
        requestError: openAiRequestError,
        upstreamError: anthropicErrorToOpenAi,
    },
    "chat-responses": {
        upstreamPath: "/v1/responses",
        toUpstream: chatRequestToResponses,
        fromUpstream: responsesResponseToChat,
        sseFromUpstream: createResponsesToChatSseStream,
        sseToUpstream: responsesObjectToChatSse,
        materialize: materializeResponsesSse,
        requestError: openAiRequestError,
        upstreamError: identityError,
    },
} satisfies Record<string, ConversionPair>;

export type ConversionAction = keyof typeof conversionPairs;
export type MatrixAction = "passthrough" | ConversionAction;
export const dispatchMatrix: Record<ApiFormat, Record<ApiFormat, ConversionPair>> = {
    anthropic: { anthropic: conversionPairs["anthropic-anthropic"], responses: conversionPairs["anthropic-responses"], chat: conversionPairs["anthropic-chat"] },
    responses: { anthropic: conversionPairs["responses-anthropic"], responses: conversionPairs["responses-responses"], chat: conversionPairs["responses-chat"] },
    chat: { anthropic: conversionPairs["chat-anthropic"], responses: conversionPairs["chat-responses"], chat: conversionPairs["chat-chat"] },
};

export function matrixAction(inbound: ApiFormat, upstream: ApiFormat): MatrixAction {
    if (inbound === upstream) return "passthrough";
    return `${inbound}-${upstream}` as ConversionAction;
}
