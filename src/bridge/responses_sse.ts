import { createParser } from "eventsource-parser";
import { array, integer, number, object, parseObjectJson, string, type JsonObject } from "./types";
import { compactJson } from "./anthropic_responses_shared";
import { ProtocolConversionError, errorMessage } from "./errors";
import { AnthropicToResponsesSseState } from "./anthropic_to_responses_sse";
import { ResponsesToAnthropicSseState } from "./responses_to_anthropic_sse";
import { parseSseJson, serializeSseEvent, type ProtocolEvent } from "./responses_sse_common";

function sseTerminated(raw: string): string {
    if (raw.endsWith("\n\n")) return raw;
    return raw.endsWith("\n") ? `${raw}\n` : `${raw}\n\n`;
}

function convertSseText(
    raw: string,
    convert: (event: JsonObject) => ProtocolEvent[],
    finish: () => ProtocolEvent[],
): string {
    let output = "";
    const parser = createParser({
        onEvent: (message) => {
            const event = parseSseJson(message);
            if (!event) return;
            output += convert(event).map(serializeSseEvent).join("");
        },
    });
    parser.feed(sseTerminated(raw));
    output += finish().map(serializeSseEvent).join("");
    return output;
}

export function convertAnthropicSseToResponses(
    raw: string,
    request: JsonObject = {},
    now?: () => number,
): string {
    const state = new AnthropicToResponsesSseState(request, now);
    return convertSseText(
        raw,
        (event) => state.push(event),
        () => state.terminal ? [] : state.fail(),
    );
}

export function convertResponsesSseToAnthropic(raw: string, request: JsonObject = {}): string {
    const state = new ResponsesToAnthropicSseState(request);
    return convertSseText(
        raw,
        (event) => state.push(event),
        () => state.terminal ? [] : state.fail(),
    );
}

function transformSseStream(
    source: ReadableStream<Uint8Array>,
    convert: (event: JsonObject) => ProtocolEvent[],
    finish: (error?: unknown) => ProtocolEvent[],
): ReadableStream<Uint8Array> {
    const encoder = new TextEncoder();
    const decoder = new TextDecoder();
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    return new ReadableStream<Uint8Array>({
        start(controller) {
            const parser = createParser({
                onEvent: (message) => {
                    const event = parseSseJson(message);
                    if (!event) return;
                    for (const converted of convert(event)) {
                        controller.enqueue(encoder.encode(serializeSseEvent(converted)));
                    }
                },
            });
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
                    for (const event of finish()) controller.enqueue(encoder.encode(serializeSseEvent(event)));
                    controller.close();
                } catch (error) {
                    for (const event of finish(error)) controller.enqueue(encoder.encode(serializeSseEvent(event)));
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

export function createAnthropicToResponsesSseStream(
    source: ReadableStream<Uint8Array>,
    request: JsonObject = {},
): ReadableStream<Uint8Array> {
    const state = new AnthropicToResponsesSseState(request);
    return transformSseStream(
        source,
        (event) => state.push(event),
        (error) => state.terminal ? [] : state.fail(error instanceof Error ? error.message : undefined),
    );
}

export function createResponsesToAnthropicSseStream(
    source: ReadableStream<Uint8Array>,
    request: JsonObject = {},
): ReadableStream<Uint8Array> {
    const state = new ResponsesToAnthropicSseState(request);
    return transformSseStream(
        source,
        (event) => state.push(event),
        (error) => state.terminal ? [] : state.fail(error instanceof Error ? error.message : undefined),
    );
}

export function responsesObjectToAnthropicSse(response: JsonObject, request: JsonObject = {}): string {
    const state = new ResponsesToAnthropicSseState(request);
    const type = response.status === "failed"
        ? "response.failed"
        : response.status === "incomplete"
            ? "response.incomplete"
            : "response.completed";
    return state.push({ type, response }).map(serializeSseEvent).join("");
}

export function anthropicObjectToResponsesSse(response: JsonObject, request: JsonObject = {}): string {
    const state = new AnthropicToResponsesSseState(request);
    const usage = object(response.usage) ?? {};
    const events: JsonObject[] = [{
        type: "message_start",
        message: {
            id: response.id,
            model: response.model,
            usage: { ...usage, output_tokens: 0 },
        },
    }];
    for (const [index, rawBlock] of array(response.content).entries()) {
        const block = object(rawBlock);
        if (!block) continue;
        const startBlock = block.type === "text"
            ? { type: "text", text: "" }
            : block.type === "tool_use"
                ? { type: "tool_use", id: block.id, name: block.name, input: {} }
                : block.type === "thinking"
                    ? { type: "thinking", thinking: "", signature: block.signature }
                    : undefined;
        if (!startBlock) continue;
        events.push({ type: "content_block_start", index, content_block: startBlock });
        if (block.type === "text" && string(block.text)) {
            events.push({ type: "content_block_delta", index, delta: { type: "text_delta", text: block.text } });
        }
        if (block.type === "tool_use") {
            events.push({
                type: "content_block_delta",
                index,
                delta: { type: "input_json_delta", partial_json: compactJson(block.input) },
            });
        }
        if (block.type === "thinking" && string(block.thinking)) {
            events.push({
                type: "content_block_delta",
                index,
                delta: { type: "thinking_delta", thinking: block.thinking },
            });
        }
        events.push({ type: "content_block_stop", index });
    }
    events.push(
        {
            type: "message_delta",
            delta: { stop_reason: response.stop_reason, stop_sequence: null },
            usage: { output_tokens: number(usage.output_tokens) ?? 0 },
        },
        { type: "message_stop" },
    );
    return events.flatMap((event) => state.push(event)).map(serializeSseEvent).join("");
}

export function materializeResponsesSse(raw: string): JsonObject {
    let completed: JsonObject | undefined;
    let failed: JsonObject | undefined;
    let terminalCount = 0;
    const parser = createParser({
        onEvent: (message) => {
            const event = parseSseJson(message);
            if (!event) return;
            if (event.type === "response.completed" || event.type === "response.incomplete") {
                terminalCount++;
                completed = object(event.response) ?? undefined;
            }
            if (event.type === "response.failed" || event.type === "error") {
                terminalCount++;
                failed = event;
            }
        },
    });
    parser.feed(sseTerminated(raw));
    if (terminalCount > 1) throw new ProtocolConversionError("Responses stream contained multiple terminal events", 502);
    if (failed) throw new ProtocolConversionError(errorMessage(failed, "Upstream stream failed"), 502);
    if (!completed) throw new ProtocolConversionError("Responses stream ended without a terminal response", 502);
    return completed;
}

export function materializeAnthropicSse(raw: string, request: JsonObject = {}): JsonObject {
    const blocks = new Map<number, JsonObject>();
    let message: JsonObject = {
        id: `msg_${crypto.randomUUID()}`,
        type: "message",
        role: "assistant",
        model: string(request.model) ?? "unknown",
        content: [],
        stop_reason: "end_turn",
        stop_sequence: null,
        usage: { input_tokens: 0, output_tokens: 0 },
    };
    let terminal = false;
    let terminalCount = 0;
    let failure: JsonObject | undefined;
    const parser = createParser({
        onEvent: (record) => {
            const event = parseSseJson(record);
            if (!event) return;
            if (event.type === "message_start") {
                message = { ...message, ...(object(event.message) ?? {}), content: [] };
            }
            if (event.type === "content_block_start") {
                const block = { ...(object(event.content_block) ?? {}) };
                if (block.type === "tool_use") block.input = {};
                blocks.set(integer(event.index) ?? 0, block);
            }
            if (event.type === "content_block_delta") {
                const block = blocks.get(integer(event.index) ?? 0);
                const delta = object(event.delta);
                if (!block || !delta) return;
                if (delta.type === "text_delta") block.text = `${string(block.text) ?? ""}${string(delta.text) ?? ""}`;
                if (delta.type === "thinking_delta") {
                    block.thinking = `${string(block.thinking) ?? ""}${string(delta.thinking) ?? ""}`;
                }
                if (delta.type === "signature_delta") block.signature = delta.signature;
                if (delta.type === "input_json_delta") {
                    block.__arguments = `${string(block.__arguments) ?? ""}${string(delta.partial_json) ?? ""}`;
                }
            }
            if (event.type === "content_block_stop") {
                const block = blocks.get(integer(event.index) ?? 0);
                if (block?.type === "tool_use") {
                    block.input = parseObjectJson(block.__arguments);
                    delete block.__arguments;
                }
            }
            if (event.type === "message_delta") {
                message.stop_reason = object(event.delta)?.stop_reason ?? message.stop_reason;
                message.usage = { ...(object(message.usage) ?? {}), ...(object(event.usage) ?? {}) };
            }
            if (event.type === "message_stop") {
                terminal = true;
                terminalCount++;
            }
            if (event.type === "error") {
                failure = event;
                terminalCount++;
            }
        },
    });
    parser.feed(sseTerminated(raw));
    if (terminalCount > 1) throw new ProtocolConversionError("Anthropic stream contained multiple terminal events", 502);
    if (failure) throw new ProtocolConversionError(errorMessage(failure, "Upstream stream failed"), 502);
    if (!terminal) throw new ProtocolConversionError("Anthropic stream ended without message_stop", 502);
    message.content = [...blocks.entries()].sort(([left], [right]) => left - right).map(([, block]) => block);
    return message;
}
