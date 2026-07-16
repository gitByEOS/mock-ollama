import { createParser } from "eventsource-parser";
import { array, number, object, string, type JsonObject } from "./types";
import { anthropicStopReason, anthropicUsage } from "./anthropic_chat";
import { parseSseJson, transformSse } from "./chat_responses_sse";

export function sseEvent(type: string, data: JsonObject): string {
    return `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
}

/** 完整 Anthropic 响应包装为 SSE，供不支持上游流式的网关降级使用。 */
export function anthropicResponseToSse(response: JsonObject): string {
    const content = array(response.content)
        .map(object)
        .filter((block): block is JsonObject => block !== null);
    const usage = object(response.usage) ?? {};
    const events: string[] = [sseEvent("message_start", {
        message: {
            id: string(response.id) ?? `msg_${crypto.randomUUID()}`,
            type: "message",
            role: "assistant",
            model: string(response.model) ?? "unknown",
            content: [],
            stop_reason: null,
            stop_sequence: null,
            usage: {
                input_tokens: typeof usage.input_tokens === "number" ? usage.input_tokens : 0,
                output_tokens: 0,
            },
        },
    })];

    for (const [index, block] of content.entries()) {
        const type = string(block.type);
        if (type === "text") {
            events.push(sseEvent("content_block_start", {
                index,
                content_block: { type: "text", text: "" },
            }));
            const text = string(block.text);
            if (text) {
                events.push(sseEvent("content_block_delta", {
                    index,
                    delta: { type: "text_delta", text },
                }));
            }
        } else if (type === "tool_use") {
            events.push(sseEvent("content_block_start", {
                index,
                content_block: {
                    type: "tool_use",
                    id: string(block.id) ?? `toolu_${index}`,
                    name: string(block.name) ?? "unknown",
                    input: {},
                },
            }));
            events.push(sseEvent("content_block_delta", {
                index,
                delta: {
                    type: "input_json_delta",
                    partial_json: JSON.stringify(object(block.input) ?? {}),
                },
            }));
        } else {
            continue;
        }
        events.push(sseEvent("content_block_stop", { index }));
    }

    events.push(sseEvent("message_delta", {
        delta: {
            stop_reason: string(response.stop_reason) ?? "end_turn",
            stop_sequence: null,
        },
        usage: {
            output_tokens: typeof usage.output_tokens === "number" ? usage.output_tokens : 0,
        },
    }));
    events.push(sseEvent("message_stop", {}));
    return events.join("");
}

type StreamState = {
    nextBlockIndex: number;
    messageId: string;
    model: string;
    finishReason: unknown;
    usage: unknown;
    textBlockIndex?: number;
    toolBlockIndexes: Map<number, number>;
    openBlocks: Set<number>;
    terminal: boolean;
};

export function createChatToAnthropicSseStream(
    source: ReadableStream<Uint8Array>,
    request: JsonObject,
): ReadableStream<Uint8Array> {
    const encoder = new TextEncoder();
    const decoder = new TextDecoder();
    const state: StreamState = {
        nextBlockIndex: 0,
        messageId: `msg_${crypto.randomUUID()}`,
        model: string(request.model) ?? "unknown",
        finishReason: "stop",
        usage: undefined,
        toolBlockIndexes: new Map(),
        openBlocks: new Set(),
        terminal: false,
    };
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;

    return new ReadableStream<Uint8Array>({
        start(controller) {
            const emit = (type: string, data: JsonObject) => controller.enqueue(encoder.encode(sseEvent(type, data)));
            emit("message_start", {
                message: {
                    id: state.messageId,
                    type: "message",
                    role: "assistant",
                    model: state.model,
                    content: [],
                    stop_reason: null,
                    stop_sequence: null,
                    usage: { input_tokens: 0, output_tokens: 0 },
                },
            });

            const startTextBlock = () => {
                if (state.textBlockIndex !== undefined) return state.textBlockIndex;
                const index = state.nextBlockIndex++;
                state.textBlockIndex = index;
                state.openBlocks.add(index);
                emit("content_block_start", { index, content_block: { type: "text", text: "" } });
                return index;
            };
            const startToolBlock = (toolIndex: number, detail: JsonObject) => {
                const existing = state.toolBlockIndexes.get(toolIndex);
                if (existing !== undefined) return existing;
                const index = state.nextBlockIndex++;
                state.toolBlockIndexes.set(toolIndex, index);
                state.openBlocks.add(index);
                const fn = object(detail.function) ?? {};
                emit("content_block_start", {
                    index,
                    content_block: {
                        type: "tool_use",
                        id: string(detail.id) ?? `toolu_${toolIndex}`,
                        name: string(fn.name) ?? "unknown",
                        input: {},
                    },
                });
                return index;
            };
            const fail = (message: string) => {
                if (state.terminal) return;
                state.terminal = true;
                emit("error", { error: { type: "api_error", message } });
            };
            const processChunk = (raw: string) => {
                if (state.terminal) return;
                if (raw === "[DONE]") {
                    state.terminal = true;
                    for (const index of [...state.openBlocks].sort((a, b) => a - b)) {
                        emit("content_block_stop", { index });
                    }
                    emit("message_delta", {
                        delta: { stop_reason: anthropicStopReason(state.finishReason), stop_sequence: null },
                        usage: { output_tokens: anthropicUsage(state.usage).output_tokens },
                    });
                    emit("message_stop", {});
                    return;
                }
                let chunk: JsonObject;
                try {
                    chunk = object(JSON.parse(raw)) ?? {};
                } catch {
                    return;
                }
                if (string(chunk.id)) state.messageId = string(chunk.id) as string;
                if (string(chunk.model)) state.model = string(chunk.model) as string;
                if (chunk.usage !== undefined) state.usage = chunk.usage;
                const choice = object(array(chunk.choices)[0]);
                if (!choice) return;
                if (choice.finish_reason !== null && choice.finish_reason !== undefined) {
                    state.finishReason = choice.finish_reason;
                }
                const delta = object(choice.delta) ?? {};
                const text = string(delta.content);
                if (text) {
                    emit("content_block_delta", {
                        index: startTextBlock(),
                        delta: { type: "text_delta", text },
                    });
                }
                for (const rawToolCall of array(delta.tool_calls)) {
                    const toolCall = object(rawToolCall) ?? {};
                    const toolIndex = typeof toolCall.index === "number" ? toolCall.index : state.toolBlockIndexes.size;
                    const index = startToolBlock(toolIndex, toolCall);
                    const argumentsDelta = string(object(toolCall.function)?.arguments);
                    if (argumentsDelta) {
                        emit("content_block_delta", {
                            index,
                            delta: { type: "input_json_delta", partial_json: argumentsDelta },
                        });
                    }
                }
            };
            const parser = createParser({ onEvent: (event) => processChunk(event.data) });
            reader = source.getReader();
            void (async () => {
                try {
                    while (true) {
                        const { done, value } = await reader?.read() as ReadableStreamReadResult<Uint8Array>;
                        if (done) break;
                        parser.feed(decoder.decode(value, { stream: true }));
                    }
                    parser.feed(decoder.decode());
                    parser.reset({ consume: true });
                    if (!state.terminal) fail("Upstream stream ended without [DONE]");
                    controller.close();
                } catch (error) {
                    fail(error instanceof Error ? error.message : "Upstream stream failed");
                    controller.close();
                } finally {
                    reader?.releaseLock();
                }
            })();
        },
        async cancel(reason) {
            await reader?.cancel(reason);
        },
    });
}

type AnthropicChatState = {
    id: string;
    model: string;
    created: number;
    roleSent: boolean;
    toolIndexes: Map<number, number>;
    usage: JsonObject;
    stopReason: unknown;
    finished: boolean;
};

function newAnthropicChatState(request: JsonObject): AnthropicChatState {
    return {
        id: `chatcmpl-${crypto.randomUUID()}`,
        model: string(request.model) ?? "unknown",
        created: Math.floor(Date.now() / 1000),
        roleSent: false,
        toolIndexes: new Map(),
        usage: {},
        stopReason: "end_turn",
        finished: false,
    };
}

function anthropicChatFinishReason(reason: unknown, hasTools: boolean): string {
    if (hasTools || reason === "tool_use") return "tool_calls";
    if (reason === "max_tokens") return "length";
    return "stop";
}

function anthropicUsageToChat(value: unknown): JsonObject {
    const usage = object(value) ?? {};
    const cached = number(usage.cache_read_input_tokens) ?? 0;
    const prompt = (number(usage.input_tokens) ?? 0) + (number(usage.cache_creation_input_tokens) ?? 0) + cached;
    const completion = number(usage.output_tokens) ?? 0;
    return {
        prompt_tokens: prompt,
        completion_tokens: completion,
        total_tokens: prompt + completion,
        prompt_tokens_details: { cached_tokens: cached },
    };
}

function anthropicChatChunk(state: AnthropicChatState, delta: JsonObject, finishReason: unknown = null, usage?: JsonObject): string {
    return `data: ${JSON.stringify({
        id: state.id,
        object: "chat.completion.chunk",
        created: state.created,
        model: state.model,
        choices: [{ index: 0, delta, finish_reason: finishReason }],
        ...(usage ? { usage } : {}),
    })}\n\n`;
}

function finishAnthropicChat(state: AnthropicChatState): string {
    if (state.finished) return "";
    let output = state.roleSent ? "" : anthropicChatChunk(state, { role: "assistant", content: "" });
    state.roleSent = true;
    output += anthropicChatChunk(
        state,
        {},
        anthropicChatFinishReason(state.stopReason, state.toolIndexes.size > 0),
        anthropicUsageToChat(state.usage),
    );
    output += "data: [DONE]\n\n";
    state.finished = true;
    return output;
}

function pushAnthropicChatEvent(state: AnthropicChatState, event: JsonObject): string {
    const type = string(event.type) ?? "";
    if (type === "message_start") {
        const message = object(event.message) ?? {};
        const sourceId = string(message.id);
        if (sourceId) state.id = sourceId.startsWith("chatcmpl-") ? sourceId : `chatcmpl-${sourceId.replace(/^msg_/, "")}`;
        if (string(message.model)) state.model = string(message.model) as string;
        state.usage = object(message.usage) ?? state.usage;
        return "";
    }
    if (type === "content_block_start") {
        const block = object(event.content_block) ?? {};
        if (block.type !== "tool_use") return "";
        const blockIndex = number(event.index) ?? state.toolIndexes.size;
        const toolIndex = state.toolIndexes.size;
        state.toolIndexes.set(blockIndex, toolIndex);
        let output = "";
        if (!state.roleSent) {
            output += anthropicChatChunk(state, { role: "assistant", content: "" });
            state.roleSent = true;
        }
        output += anthropicChatChunk(state, {
            tool_calls: [{
                index: toolIndex,
                id: string(block.id) ?? `toolu_${toolIndex}`,
                type: "function",
                function: { name: string(block.name) ?? "unknown", arguments: "" },
            }],
        });
        return output;
    }
    if (type === "content_block_delta") {
        const delta = object(event.delta) ?? {};
        let output = "";
        if (!state.roleSent) {
            output += anthropicChatChunk(state, { role: "assistant", content: "" });
            state.roleSent = true;
        }
        if (delta.type === "text_delta") {
            return output + anthropicChatChunk(state, { content: string(delta.text) ?? "" });
        }
        if (delta.type === "input_json_delta") {
            const blockIndex = number(event.index) ?? 0;
            return output + anthropicChatChunk(state, {
                tool_calls: [{
                    index: state.toolIndexes.get(blockIndex) ?? blockIndex,
                    function: { arguments: string(delta.partial_json) ?? "" },
                }],
            });
        }
        return output;
    }
    if (type === "message_delta") {
        const delta = object(event.delta) ?? {};
        if (delta.stop_reason !== undefined) state.stopReason = delta.stop_reason;
        state.usage = { ...state.usage, ...(object(event.usage) ?? {}) };
        return "";
    }
    if (type === "message_stop") return finishAnthropicChat(state);
    if (type === "error") {
        state.finished = true;
        return `data: ${JSON.stringify({ error: object(event.error) ?? { message: "Upstream stream failed" } })}\n\n`;
    }
    return "";
}

/** Anthropic Messages SSE 直转 Chat Completions SSE，不借道 Responses。 */
export function createAnthropicToChatSseStream(source: ReadableStream<Uint8Array>, request: JsonObject = {}) {
    const state = newAnthropicChatState(request);
    return transformSse(source, (message) => {
        const event = parseSseJson(message);
        return event && event !== "done" ? pushAnthropicChatEvent(state, event) : "";
    }, (error) => {
        if (state.finished) return "";
        state.finished = true;
        return `data: ${JSON.stringify({
            error: { type: "api_error", message: error instanceof Error ? error.message : "Upstream stream ended without message_stop" },
        })}\n\n`;
    });
}

/** Anthropic Messages 普通响应直包 Chat Completions SSE。 */
export function anthropicObjectToChatSse(response: JsonObject, request: JsonObject = {}): string {
    const state = newAnthropicChatState(request);
    const usage = object(response.usage) ?? {};
    let output = pushAnthropicChatEvent(state, {
        type: "message_start",
        message: { id: response.id, model: response.model, usage: { ...usage, output_tokens: 0 } },
    });
    for (const [index, rawBlock] of array(response.content).entries()) {
        const block = object(rawBlock);
        if (!block) continue;
        output += pushAnthropicChatEvent(state, { type: "content_block_start", index, content_block: block });
        if (block.type === "text") {
            output += pushAnthropicChatEvent(state, { type: "content_block_delta", index, delta: { type: "text_delta", text: block.text } });
        }
        if (block.type === "tool_use") {
            output += pushAnthropicChatEvent(state, {
                type: "content_block_delta",
                index,
                delta: { type: "input_json_delta", partial_json: JSON.stringify(object(block.input) ?? {}) },
            });
        }
    }
    output += pushAnthropicChatEvent(state, {
        type: "message_delta",
        delta: { stop_reason: response.stop_reason },
        usage,
    });
    return output + pushAnthropicChatEvent(state, { type: "message_stop" });
}
