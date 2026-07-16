import { createParser, type EventSourceMessage } from "eventsource-parser";
import { array, number, object, string, type JsonObject } from "./types";

type ChatStreamState = {
    id: string;
    model: string;
    created: number;
    started: boolean;
    textStarted: boolean;
    text: string;
    textItemId: string;
    textOutputIndex?: number;
    nextOutputIndex: number;
    tools: Map<number, { itemId: string; callId: string; name: string; arguments: string; outputIndex: number }>;
    usage: JsonObject;
    sequence: number;
    finished: boolean;
    pendingFinish: unknown;
};

export function parseSseJson(message: EventSourceMessage): JsonObject | "done" | undefined {
    if (message.data === "[DONE]") return "done";
    try {
        return object(JSON.parse(message.data)) ?? undefined;
    } catch {
        return undefined;
    }
}

function responseEvent(state: ChatStreamState, type: string, data: JsonObject): string {
    return `event: ${type}\ndata: ${JSON.stringify({ type, sequence_number: ++state.sequence, ...data })}\n\n`;
}

function responseSnapshot(state: ChatStreamState, status: string): JsonObject {
    const indexedOutput: Array<[number, JsonObject]> = [];
    if (state.textStarted) {
        indexedOutput.push([state.textOutputIndex as number, {
            id: state.textItemId,
            type: "message",
            status: status === "completed" ? "completed" : "in_progress",
            role: "assistant",
            content: [{ type: "output_text", text: state.text, annotations: [] }],
        }]);
    }
    for (const tool of state.tools.values()) {
        indexedOutput.push([tool.outputIndex, {
            id: tool.itemId,
            type: "function_call",
            status: status === "completed" ? "completed" : "in_progress",
            call_id: tool.callId,
            name: tool.name,
            arguments: tool.arguments,
        }]);
    }
    const output = indexedOutput.sort(([left], [right]) => left - right).map(([, item]) => item);
    const input = number(state.usage.prompt_tokens) ?? 0;
    const outputTokens = number(state.usage.completion_tokens) ?? 0;
    return {
        id: state.id,
        object: "response",
        created_at: state.created,
        model: state.model,
        status,
        output,
        usage: {
            input_tokens: input,
            input_tokens_details: object(state.usage.prompt_tokens_details) ?? { cached_tokens: 0 },
            output_tokens: outputTokens,
            total_tokens: number(state.usage.total_tokens) ?? input + outputTokens,
        },
    };
}

function pushChatChunk(state: ChatStreamState, chunk: JsonObject | "done"): string {
    if (state.finished) return "";
    if (chunk === "done") return finishChatStream(state, state.pendingFinish);
    if (string(chunk.id)) state.id = string(chunk.id)?.replace(/^chatcmpl-/, "resp_") as string;
    if (string(chunk.model)) state.model = chunk.model as string;
    if (number(chunk.created) !== undefined) state.created = number(chunk.created) as number;
    if (object(chunk.usage)) state.usage = object(chunk.usage) as JsonObject;
    let output = "";
    if (!state.started) {
        state.started = true;
        const snapshot = responseSnapshot(state, "in_progress");
        output += responseEvent(state, "response.created", { response: snapshot });
        output += responseEvent(state, "response.in_progress", { response: snapshot });
    }
    const choice = object(array(chunk.choices)[0]);
    if (!choice) return output;
    const delta = object(choice.delta) ?? {};
    const text = string(delta.content);
    if (text !== undefined) {
        if (!state.textStarted) {
            state.textStarted = true;
            state.textOutputIndex = state.nextOutputIndex++;
            output += responseEvent(state, "response.output_item.added", {
                output_index: state.textOutputIndex,
                item: { id: state.textItemId, type: "message", status: "in_progress", role: "assistant", content: [] },
            });
            output += responseEvent(state, "response.content_part.added", {
                item_id: state.textItemId, output_index: state.textOutputIndex, content_index: 0,
                part: { type: "output_text", text: "", annotations: [] },
            });
        }
        state.text += text;
        if (text) output += responseEvent(state, "response.output_text.delta", {
            item_id: state.textItemId, output_index: state.textOutputIndex, content_index: 0, delta: text,
        });
    }
    for (const rawCall of array(delta.tool_calls)) {
        const call = object(rawCall) ?? {};
        const index = number(call.index) ?? state.tools.size;
        const fn = object(call.function) ?? {};
        let tool = state.tools.get(index);
        if (!tool) {
            const callId = string(call.id) ?? `call_${index}`;
            tool = {
                itemId: `fc_${callId}`,
                callId,
                name: string(fn.name) ?? "unknown",
                arguments: "",
                outputIndex: state.nextOutputIndex++,
            };
            state.tools.set(index, tool);
            output += responseEvent(state, "response.output_item.added", {
                output_index: tool.outputIndex,
                item: { id: tool.itemId, type: "function_call", status: "in_progress", call_id: callId, name: tool.name, arguments: "" },
            });
        }
        if (string(call.id)) tool.callId = call.id as string;
        if (string(fn.name)) tool.name = fn.name as string;
        const fragment = string(fn.arguments) ?? "";
        tool.arguments += fragment;
        if (fragment) output += responseEvent(state, "response.function_call_arguments.delta", {
            item_id: tool.itemId,
            output_index: tool.outputIndex,
            delta: fragment,
        });
    }
    if (choice.finish_reason !== null && choice.finish_reason !== undefined) state.pendingFinish = choice.finish_reason;
    return output;
}

function failChatStream(state: ChatStreamState, message = "Upstream stream ended without [DONE]"): string {
    if (state.finished) return "";
    state.finished = true;
    if (!state.started) state.started = true;
    const response = responseSnapshot(state, "failed");
    response.error = { type: "api_error", message };
    return responseEvent(state, "response.failed", { response });
}

function finishChatStream(state: ChatStreamState, finishReason: unknown = "stop"): string {
    if (state.finished) return "";
    state.finished = true;
    let output = "";
    if (state.textStarted) {
        const outputIndex = state.textOutputIndex as number;
        output += responseEvent(state, "response.output_text.done", {
            item_id: state.textItemId, output_index: outputIndex, content_index: 0, text: state.text,
        });
        output += responseEvent(state, "response.content_part.done", {
            item_id: state.textItemId, output_index: outputIndex, content_index: 0,
            part: { type: "output_text", text: state.text, annotations: [] },
        });
        output += responseEvent(state, "response.output_item.done", {
            output_index: outputIndex,
            item: {
                id: state.textItemId,
                type: "message",
                status: "completed",
                role: "assistant",
                content: [{ type: "output_text", text: state.text, annotations: [] }],
            },
        });
    }
    for (const tool of [...state.tools.values()].sort((left, right) => left.outputIndex - right.outputIndex)) {
        const outputIndex = tool.outputIndex;
        output += responseEvent(state, "response.function_call_arguments.done", {
            item_id: tool.itemId, output_index: outputIndex, arguments: tool.arguments,
        });
        output += responseEvent(state, "response.output_item.done", {
            output_index: outputIndex,
            item: { id: tool.itemId, type: "function_call", status: "completed", call_id: tool.callId, name: tool.name, arguments: tool.arguments },
        });
    }
    const incomplete = finishReason === "length";
    const response = responseSnapshot(state, incomplete ? "incomplete" : "completed");
    if (incomplete) response.incomplete_details = { reason: "max_output_tokens" };
    output += responseEvent(state, incomplete ? "response.incomplete" : "response.completed", { response });
    return output;
}

function newChatStreamState(request: JsonObject): ChatStreamState {
    return {
        id: `resp_${crypto.randomUUID()}`,
        model: string(request.model) ?? "unknown",
        created: Math.floor(Date.now() / 1000),
        started: false,
        textStarted: false,
        text: "",
        textItemId: `msg_${crypto.randomUUID()}`,
        nextOutputIndex: 0,
        tools: new Map(),
        usage: {},
        sequence: 0,
        finished: false,
        pendingFinish: "stop",
    };
}

/** Chat Completions SSE 转 Responses SSE。 */
export function materializeChatSse(raw: string, request: JsonObject = {}): JsonObject {
    const tools = new Map<number, JsonObject>();
    let id = `chatcmpl-${crypto.randomUUID()}`;
    let model = string(request.model) ?? "unknown";
    let created = Math.floor(Date.now() / 1000);
    let content = "";
    let finishReason: unknown;
    let usage: JsonObject | undefined;
    let terminal = false;
    let failure: JsonObject | undefined;
    const parser = createParser({ onEvent: (message) => {
        const event = parseSseJson(message);
        if (event === "done") {
            terminal = true;
            return;
        }
        if (!event) return;
        if (object(event.error)) {
            failure = event;
            return;
        }
        if (string(event.id)) id = event.id as string;
        if (string(event.model)) model = event.model as string;
        if (number(event.created) !== undefined) created = event.created as number;
        if (object(event.usage)) usage = event.usage as JsonObject;
        const choice = object(array(event.choices)[0]);
        if (!choice) return;
        if (choice.finish_reason !== null && choice.finish_reason !== undefined) finishReason = choice.finish_reason;
        const delta = object(choice.delta) ?? {};
        content += string(delta.content) ?? "";
        for (const rawCall of array(delta.tool_calls)) {
            const call = object(rawCall) ?? {};
            const index = number(call.index) ?? tools.size;
            const fn = object(call.function) ?? {};
            const tool = tools.get(index) ?? { id: call.id, type: "function", function: { name: "unknown", arguments: "" } };
            if (string(call.id)) tool.id = call.id;
            const toolFunction = object(tool.function) ?? {};
            if (string(fn.name)) toolFunction.name = fn.name;
            toolFunction.arguments = `${string(toolFunction.arguments) ?? ""}${string(fn.arguments) ?? ""}`;
            tool.function = toolFunction;
            tools.set(index, tool);
        }
    } });
    parser.feed(raw.endsWith("\n\n") ? raw : `${raw}\n\n`);
    if (failure) throw new Error(string(object(failure.error)?.message) ?? "Upstream stream failed");
    if (!terminal) throw new Error("Chat stream ended without [DONE]");
    return {
        id,
        object: "chat.completion",
        created,
        model,
        choices: [{
            index: 0,
            message: {
                role: "assistant",
                content: content || null,
                ...(tools.size ? { tool_calls: [...tools.entries()].sort(([a], [b]) => a - b).map(([, tool]) => tool) } : {}),
            },
            finish_reason: finishReason ?? (tools.size ? "tool_calls" : "stop"),
        }],
        ...(usage ? { usage } : {}),
    };
}

/** Chat Completions SSE 转 Responses SSE。 */
export function convertChatSseToResponses(raw: string, request: JsonObject = {}): string {
    const state = newChatStreamState(request);
    let output = "";
    const parser = createParser({ onEvent: (message) => {
        const event = parseSseJson(message);
        if (event) output += pushChatChunk(state, event);
    } });
    parser.feed(raw.endsWith("\n\n") ? raw : `${raw}\n\n`);
    if (!state.finished) output += failChatStream(state);
    return output;
}

type ResponsesChatState = {
    id: string;
    model: string;
    created: number;
    roleSent: boolean;
    toolIndexes: Map<string, number>;
    hasTools: boolean;
    finished: boolean;
    usage?: JsonObject;
};

function chatChunk(state: ResponsesChatState, delta: JsonObject, finishReason: unknown = null, usage?: JsonObject): string {
    return `data: ${JSON.stringify({
        id: state.id,
        object: "chat.completion.chunk",
        created: state.created,
        model: state.model,
        choices: [{ index: 0, delta, finish_reason: finishReason }],
        ...(usage ? { usage } : {}),
    })}\n\n`;
}

function responsesUsageToChat(value: unknown): JsonObject {
    const usage = object(value) ?? {};
    const prompt = number(usage.input_tokens) ?? 0;
    const completion = number(usage.output_tokens) ?? 0;
    return { prompt_tokens: prompt, completion_tokens: completion, total_tokens: number(usage.total_tokens) ?? prompt + completion };
}

function failResponsesChat(state: ResponsesChatState, message = "Upstream stream ended without a terminal response"): string {
    if (state.finished) return "";
    state.finished = true;
    return `data: ${JSON.stringify({ error: { type: "api_error", message } })}\n\n`;
}

function pushResponsesEvent(state: ResponsesChatState, event: JsonObject): string {
    if (state.finished) return "";
    const type = string(event.type) ?? "";
    const response = object(event.response);
    if (response) {
        if (string(response.id)) state.id = (response.id as string).replace(/^resp_/, "chatcmpl-");
        if (string(response.model)) state.model = response.model as string;
        if (number(response.created_at) !== undefined) state.created = response.created_at as number;
        if (object(response.usage)) state.usage = response.usage as JsonObject;
    }
    let output = "";
    const ensureRole = () => {
        if (state.roleSent) return "";
        state.roleSent = true;
        return chatChunk(state, { role: "assistant", content: "" });
    };
    if (type === "response.output_text.delta") {
        output += ensureRole();
        output += chatChunk(state, { content: string(event.delta) ?? "" });
    }
    if (type === "response.output_item.added") {
        const item = object(event.item) ?? {};
        if (item.type === "function_call") {
            output += ensureRole();
            state.hasTools = true;
            const id = string(item.id) ?? string(item.call_id) ?? `fc_${state.toolIndexes.size}`;
            const index = state.toolIndexes.size;
            state.toolIndexes.set(id, index);
            output += chatChunk(state, { tool_calls: [{ index, id: string(item.call_id) ?? id.replace(/^fc_/, ""), type: "function", function: { name: string(item.name) ?? "unknown", arguments: "" } }] });
        }
    }
    if (type === "response.function_call_arguments.delta") {
        output += ensureRole();
        const itemId = string(event.item_id) ?? "";
        const index = state.toolIndexes.get(itemId) ?? number(event.output_index) ?? 0;
        output += chatChunk(state, { tool_calls: [{ index, function: { arguments: string(event.delta) ?? "" } }] });
    }
    if (type === "response.completed" || type === "response.incomplete") {
        output += ensureRole();
        const complete = response ?? {};
        const terminalHasTools = array(complete.output).some((item) => object(item)?.type === "function_call");
        const finish = type === "response.incomplete" ? "length" : state.hasTools || terminalHasTools ? "tool_calls" : "stop";
        output += chatChunk(state, {}, finish, responsesUsageToChat(complete.usage ?? state.usage));
        output += "data: [DONE]\n\n";
        state.finished = true;
    }
    if (type === "response.failed" || type === "error") {
        output += failResponsesChat(
            state,
            string(object(event.error)?.message) ?? string(object(object(event.response)?.error)?.message) ?? "Upstream stream failed",
        );
    }
    return output;
}

function newResponsesChatState(request: JsonObject): ResponsesChatState {
    return {
        id: `chatcmpl-${crypto.randomUUID()}`,
        model: string(request.model) ?? "unknown",
        created: Math.floor(Date.now() / 1000),
        roleSent: false,
        toolIndexes: new Map(),
        hasTools: false,
        finished: false,
    };
}

/** Responses SSE 转 Chat Completions SSE。 */
export function convertResponsesSseToChat(raw: string, request: JsonObject = {}): string {
    const state = newResponsesChatState(request);
    let output = "";
    const parser = createParser({ onEvent: (message) => {
        const event = parseSseJson(message);
        if (event && event !== "done") output += pushResponsesEvent(state, event);
    } });
    parser.feed(raw.endsWith("\n\n") ? raw : `${raw}\n\n`);
    return output;
}

export function transformSse(
    source: ReadableStream<Uint8Array>,
    convert: (message: EventSourceMessage) => string,
    finish: (error?: unknown) => string = () => "",
): ReadableStream<Uint8Array> {
    const encoder = new TextEncoder();
    const decoder = new TextDecoder();
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    return new ReadableStream({
        start(controller) {
            const enqueue = (value: string) => { if (value) controller.enqueue(encoder.encode(value)); };
            const parser = createParser({ onEvent: (message) => enqueue(convert(message)) });
            reader = source.getReader();
            void (async () => {
                try {
                    while (true) {
                        const result = await reader?.read();
                        if (!result || result.done) break;
                        parser.feed(decoder.decode(result.value, { stream: true }));
                    }
                    const tail = decoder.decode();
                    if (tail) parser.feed(tail);
                    parser.reset({ consume: true });
                    enqueue(finish());
                    controller.close();
                } catch (error) {
                    enqueue(finish(error));
                    controller.close();
                } finally {
                    reader?.releaseLock();
                }
            })();
        },
        async cancel(reason) { await reader?.cancel(reason); },
    });
}

export function createChatToResponsesSseStream(source: ReadableStream<Uint8Array>, request: JsonObject = {}) {
    const state = newChatStreamState(request);
    return transformSse(source, (message) => {
        const event = parseSseJson(message);
        return event ? pushChatChunk(state, event) : "";
    }, (error) => state.finished
        ? ""
        : failChatStream(state, error instanceof Error ? error.message : undefined));
}

export function createResponsesToChatSseStream(source: ReadableStream<Uint8Array>, request: JsonObject = {}) {
    const state = newResponsesChatState(request);
    return transformSse(source, (message) => {
        const event = parseSseJson(message);
        return event && event !== "done" ? pushResponsesEvent(state, event) : "";
    }, (error) => state.finished
        ? ""
        : failResponsesChat(state, error instanceof Error ? error.message : undefined));
}

export function chatObjectToResponsesSse(response: JsonObject, request: JsonObject = {}): string {
    const state = newChatStreamState(request);
    const choice = object(array(response.choices)[0]) ?? {};
    const message = object(choice.message) ?? {};
    const common = { id: response.id, model: response.model, created: response.created };
    let output = pushChatChunk(state, { ...common, choices: [{ delta: { role: "assistant" }, finish_reason: null }] });
    if (string(message.content) !== undefined) {
        output += pushChatChunk(state, { ...common, choices: [{ delta: { content: message.content }, finish_reason: null }] });
    }
    for (const [index, rawCall] of array(message.tool_calls).entries()) {
        const call = object(rawCall) ?? {};
        output += pushChatChunk(state, {
            ...common,
            choices: [{
                delta: { tool_calls: [{ index, id: call.id, type: "function", function: object(call.function) ?? {} }] },
                finish_reason: null,
            }],
        });
    }
    output += pushChatChunk(state, {
        ...common,
        usage: response.usage,
        choices: [{ delta: {}, finish_reason: choice.finish_reason ?? "stop" }],
    });
    output += pushChatChunk(state, "done");
    return output;
}

export function responsesObjectToChatSse(response: JsonObject, request: JsonObject = {}): string {
    const state = newResponsesChatState(request);
    let output = pushResponsesEvent(state, { type: "response.created", response: { ...response, status: "in_progress" } });
    for (const [outputIndex, rawItem] of array(response.output).entries()) {
        const item = object(rawItem);
        if (!item) continue;
        if (item.type === "message") {
            for (const [contentIndex, rawPart] of array(item.content).entries()) {
                const part = object(rawPart);
                if (part?.type !== "output_text") continue;
                output += pushResponsesEvent(state, {
                    type: "response.output_text.delta",
                    item_id: item.id,
                    output_index: outputIndex,
                    content_index: contentIndex,
                    delta: string(part.text) ?? "",
                });
            }
        }
        if (item.type === "function_call") {
            output += pushResponsesEvent(state, { type: "response.output_item.added", output_index: outputIndex, item });
            output += pushResponsesEvent(state, {
                type: "response.function_call_arguments.delta",
                item_id: item.id,
                output_index: outputIndex,
                delta: string(item.arguments) ?? "",
            });
        }
    }
    output += pushResponsesEvent(state, {
        type: response.status === "failed"
            ? "response.failed"
            : response.status === "incomplete"
                ? "response.incomplete"
                : "response.completed",
        response,
    });
    return output;
}
