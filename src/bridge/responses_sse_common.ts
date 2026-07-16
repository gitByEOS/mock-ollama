import { createParser, type EventSourceMessage } from "eventsource-parser";
import { object, string, type JsonObject } from "./types";

export type ProtocolEvent = {
    event: string;
    data: JsonObject;
};

export function protocolEvent(event: string, data: JsonObject): ProtocolEvent {
    return { event, data: { type: event, ...data } };
}

export function serializeSseEvent(event: ProtocolEvent): string {
    return `event: ${event.event}\ndata: ${JSON.stringify(event.data)}\n\n`;
}

type IdentitySseProtocol = "anthropic" | "responses" | "chat";

function identityFailure(protocol: IdentitySseProtocol, message: string): string {
    if (protocol === "anthropic") {
        return serializeSseEvent(protocolEvent("error", { error: { type: "api_error", message } }));
    }
    if (protocol === "responses") {
        const response = { object: "response", status: "failed", error: { type: "api_error", message } };
        return serializeSseEvent(protocolEvent("response.failed", { response }));
    }
    return `data: ${JSON.stringify({ error: { type: "api_error", message } })}\n\n`;
}

function createValidatedIdentitySseStream(
    source: ReadableStream<Uint8Array>,
    protocol: IdentitySseProtocol,
): ReadableStream<Uint8Array> {
    const encoder = new TextEncoder();
    const decoder = new TextDecoder();
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    let terminal = false;
    return new ReadableStream<Uint8Array>({
        start(controller) {
            const parser = createParser({ onEvent: (message) => {
                if (protocol === "chat") {
                    if (message.data === "[DONE]") terminal = true;
                    return;
                }
                const event = parseSseJson(message);
                const type = string(event?.type);
                if (protocol === "anthropic" && (type === "message_stop" || type === "error")) terminal = true;
                if (protocol === "responses" && ["response.completed", "response.incomplete", "response.failed", "error"].includes(type ?? "")) {
                    terminal = true;
                }
            } });
            const fail = (error?: unknown) => {
                if (terminal) return;
                terminal = true;
                const fallback = protocol === "chat"
                    ? "Upstream stream ended without [DONE]"
                    : protocol === "anthropic"
                        ? "Upstream stream ended without message_stop"
                        : "Upstream stream ended without a terminal response";
                controller.enqueue(encoder.encode(identityFailure(protocol, error instanceof Error ? error.message : fallback)));
            };
            reader = source.getReader();
            void (async () => {
                try {
                    while (true) {
                        const result = await reader?.read();
                        if (!result || result.done) break;
                        parser.feed(decoder.decode(result.value, { stream: true }));
                        controller.enqueue(result.value);
                    }
                    const tail = decoder.decode();
                    if (tail) parser.feed(tail);
                    parser.reset({ consume: true });
                    fail();
                    controller.close();
                } catch (error) {
                    fail(error);
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

export function createAnthropicIdentitySseStream(source: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> {
    return createValidatedIdentitySseStream(source, "anthropic");
}

export function createResponsesIdentitySseStream(source: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> {
    return createValidatedIdentitySseStream(source, "responses");
}

export function createChatIdentitySseStream(source: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> {
    return createValidatedIdentitySseStream(source, "chat");
}

export function responsesResponseToSse(response: JsonObject): string {
    const type = response.status === "failed"
        ? "response.failed"
        : response.status === "incomplete"
            ? "response.incomplete"
            : "response.completed";
    return serializeSseEvent(protocolEvent(type, { response }));
}

export function chatResponseToSse(response: JsonObject): string {
    const choices = Array.isArray(response.choices) ? response.choices : [];
    const choice = object(choices[0]) ?? {};
    const message = object(choice.message) ?? {};
    const chunk = {
        id: response.id,
        object: "chat.completion.chunk",
        created: response.created,
        model: response.model,
        choices: [{ index: 0, delta: message, finish_reason: choice.finish_reason ?? null }],
        ...(object(response.usage) ? { usage: response.usage } : {}),
    };
    return `data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`;
}

export function parseSseJson(message: EventSourceMessage): JsonObject | undefined {
    if (message.data === "[DONE]") return undefined;
    try {
        const parsed = object(JSON.parse(message.data));
        if (parsed && !string(parsed.type) && message.event) parsed.type = message.event;
        return parsed ?? undefined;
    } catch {
        return undefined;
    }
}
