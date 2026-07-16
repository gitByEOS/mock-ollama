import { array, integer, number, object, string, type JsonObject } from "./types";
import { claudeMessageId, claudeSignature, responseReasoningSummary, responsesStopReason, responsesUsageToAnthropic } from "./anthropic_responses_shared";
import { protocolEvent, type ProtocolEvent } from "./responses_sse_common";

type ResponsesStreamBlock = {
    key: string;
    itemId: string;
    index: number;
    kind: "text" | "tool" | "thinking";
    text: string;
    arguments: string;
    isStopped: boolean;
};

export class ResponsesToAnthropicSseState {
    private isStarted = false;
    private isTerminal = false;
    private messageId = "";
    private model: string;
    private nextBlock = 0;
    private hasTool = false;
    private blocks = new Map<string, ResponsesStreamBlock>();
    private items = new Map<string, JsonObject>();

    constructor(private readonly request: JsonObject = {}) {
        this.model = string(request.model) ?? "unknown";
    }

    private ensureStarted(response: JsonObject = {}): ProtocolEvent[] {
        if (this.isStarted || this.isTerminal) return [];
        this.messageId = claudeMessageId(response.id);
        this.model = string(response.model) ?? this.model;
        this.isStarted = true;
        return [protocolEvent("message_start", {
            message: {
                id: this.messageId,
                type: "message",
                role: "assistant",
                model: this.model,
                content: [],
                stop_reason: null,
                stop_sequence: null,
                usage: { input_tokens: 0, output_tokens: 0 },
            },
        })];
    }

    private textKey(itemId: string, contentIndex: number): string {
        return `${itemId}:${contentIndex}`;
    }

    private startText(itemId: string, contentIndex: number): [ResponsesStreamBlock, ProtocolEvent[]] {
        const key = this.textKey(itemId, contentIndex);
        const existing = this.blocks.get(key);
        if (existing) return [existing, []];
        const events = this.ensureStarted();
        const block: ResponsesStreamBlock = {
            key,
            itemId,
            index: this.nextBlock++,
            kind: "text",
            text: "",
            arguments: "",
            isStopped: false,
        };
        this.blocks.set(key, block);
        events.push(protocolEvent("content_block_start", {
            index: block.index,
            content_block: { type: "text", text: "" },
        }));
        return [block, events];
    }

    private startTool(itemId: string, item: JsonObject): [ResponsesStreamBlock, ProtocolEvent[]] {
        const existing = this.blocks.get(itemId);
        if (existing) return [existing, []];
        const events = this.ensureStarted();
        const callId = string(item.call_id) ?? (itemId.replace(/^fc_/, "") || `toolu_${this.nextBlock}`);
        const block: ResponsesStreamBlock = {
            key: itemId,
            itemId,
            index: this.nextBlock++,
            kind: "tool",
            text: "",
            arguments: "",
            isStopped: false,
        };
        this.hasTool = true;
        this.blocks.set(itemId, block);
        events.push(protocolEvent("content_block_start", {
            index: block.index,
            content_block: {
                type: "tool_use",
                id: callId,
                name: string(item.name) ?? "unknown",
                input: {},
            },
        }));
        return [block, events];
    }

    private startThinking(itemId: string, item: JsonObject): [ResponsesStreamBlock | undefined, ProtocolEvent[]] {
        const existing = this.blocks.get(itemId);
        if (existing) return [existing, []];
        const signature = claudeSignature(item.encrypted_content);
        if (!signature) return [undefined, []];
        const events = this.ensureStarted();
        const block: ResponsesStreamBlock = {
            key: itemId,
            itemId,
            index: this.nextBlock++,
            kind: "thinking",
            text: "",
            arguments: "",
            isStopped: false,
        };
        this.blocks.set(itemId, block);
        events.push(protocolEvent("content_block_start", {
            index: block.index,
            content_block: { type: "thinking", thinking: "", signature },
        }));
        return [block, events];
    }

    private appendText(block: ResponsesStreamBlock | undefined, text: string): ProtocolEvent[] {
        if (!block || block.isStopped || !text) return [];
        block.text += text;
        return [protocolEvent("content_block_delta", {
            index: block.index,
            delta: block.kind === "thinking"
                ? { type: "thinking_delta", thinking: text }
                : { type: "text_delta", text },
        })];
    }

    private appendMissingText(block: ResponsesStreamBlock | undefined, fullText: string): ProtocolEvent[] {
        if (!block || !fullText || block.text === fullText) return [];
        if (fullText.startsWith(block.text)) return this.appendText(block, fullText.slice(block.text.length));
        if (block.text === "") return this.appendText(block, fullText);
        return [];
    }

    private appendArguments(block: ResponsesStreamBlock, fragment: string): ProtocolEvent[] {
        if (block.isStopped || !fragment) return [];
        block.arguments += fragment;
        return [protocolEvent("content_block_delta", {
            index: block.index,
            delta: { type: "input_json_delta", partial_json: fragment },
        })];
    }

    private appendMissingArguments(block: ResponsesStreamBlock, fullArguments: string): ProtocolEvent[] {
        if (!fullArguments || block.arguments === fullArguments) return [];
        if (fullArguments.startsWith(block.arguments)) {
            return this.appendArguments(block, fullArguments.slice(block.arguments.length));
        }
        if (block.arguments === "") return this.appendArguments(block, fullArguments);
        return [];
    }

    private stopBlock(block: ResponsesStreamBlock | undefined): ProtocolEvent[] {
        if (!block || block.isStopped) return [];
        block.isStopped = true;
        return [protocolEvent("content_block_stop", { index: block.index })];
    }

    private synthesizeItem(item: JsonObject): ProtocolEvent[] {
        const itemId = string(item.id) ?? `item_${this.items.size}`;
        this.items.set(itemId, item);
        const events: ProtocolEvent[] = [];
        if (item.type === "message") {
            for (const [contentIndex, rawPart] of array(item.content).entries()) {
                const part = object(rawPart);
                if (part?.type !== "output_text") continue;
                const [block, startEvents] = this.startText(itemId, contentIndex);
                events.push(...startEvents);
                events.push(...this.appendMissingText(block, string(part.text) ?? ""));
                events.push(...this.stopBlock(block));
            }
            return events;
        }
        if (item.type === "function_call") {
            const [block, startEvents] = this.startTool(itemId, item);
            events.push(...startEvents);
            events.push(...this.appendMissingArguments(block, string(item.arguments) ?? "{}"));
            events.push(...this.stopBlock(block));
            return events;
        }
        if (item.type === "reasoning") {
            const [block, startEvents] = this.startThinking(itemId, item);
            events.push(...startEvents);
            events.push(...this.appendMissingText(block, responseReasoningSummary(item)));
            events.push(...this.stopBlock(block));
        }
        return events;
    }

    private finish(response: JsonObject): ProtocolEvent[] {
        if (this.isTerminal) return [];
        const events = this.ensureStarted(response);
        for (const rawItem of array(response.output)) {
            const item = object(rawItem);
            if (item) events.push(...this.synthesizeItem(item));
        }
        for (const block of this.blocks.values()) events.push(...this.stopBlock(block));
        events.push(
            protocolEvent("message_delta", {
                delta: {
                    stop_reason: responsesStopReason(response, this.hasTool),
                    stop_sequence: null,
                },
                usage: responsesUsageToAnthropic(response.usage),
            }),
            protocolEvent("message_stop", {}),
        );
        this.isTerminal = true;
        return events;
    }

    private streamError(event: JsonObject): ProtocolEvent[] {
        if (this.isTerminal) return [];
        const source = object(event.error) ?? object(object(event.response)?.error) ?? {};
        const error = {
            type: string(source.type) ?? "api_error",
            message: string(source.message) ?? string(event.message) ?? "Upstream stream failed",
        };
        this.isTerminal = true;
        return [protocolEvent("error", { error })];
    }

    fail(message = "Upstream stream ended without a terminal response"): ProtocolEvent[] {
        return this.streamError({ error: { type: "api_error", message } });
    }

    get terminal(): boolean {
        return this.isTerminal;
    }

    push(event: JsonObject): ProtocolEvent[] {
        if (this.isTerminal) return [];
        const type = string(event.type);
        if (type === "response.created" || type === "response.in_progress") {
            return this.ensureStarted(object(event.response) ?? {});
        }
        if (type === "response.output_item.added") {
            const item = object(event.item) ?? {};
            const itemId = string(item.id) ?? string(event.item_id) ?? `item_${this.items.size}`;
            this.items.set(itemId, item);
            if (item.type === "function_call") return this.startTool(itemId, item)[1];
            if (item.type === "reasoning") return this.startThinking(itemId, item)[1];
            return [];
        }
        if (type === "response.content_part.added" && object(event.part)?.type === "output_text") {
            return this.startText(string(event.item_id) ?? "message", integer(event.content_index) ?? 0)[1];
        }
        if (type === "response.output_text.delta") {
            const [block, events] = this.startText(
                string(event.item_id) ?? "message",
                integer(event.content_index) ?? 0,
            );
            events.push(...this.appendText(block, string(event.delta) ?? ""));
            return events;
        }
        if (type === "response.content_part.done" && object(event.part)?.type === "output_text") {
            const [block, events] = this.startText(
                string(event.item_id) ?? "message",
                integer(event.content_index) ?? 0,
            );
            events.push(...this.appendMissingText(block, string(object(event.part)?.text) ?? ""));
            events.push(...this.stopBlock(block));
            return events;
        }
        if (type === "response.function_call_arguments.delta") {
            const itemId = string(event.item_id) ?? "function";
            const [block, events] = this.startTool(itemId, this.items.get(itemId) ?? {});
            events.push(...this.appendArguments(block, string(event.delta) ?? ""));
            return events;
        }
        if (type === "response.function_call_arguments.done") {
            const itemId = string(event.item_id) ?? "function";
            const [block, events] = this.startTool(itemId, this.items.get(itemId) ?? {});
            events.push(...this.appendMissingArguments(block, string(event.arguments) ?? "{}"));
            events.push(...this.stopBlock(block));
            return events;
        }
        if (type === "response.reasoning_summary_text.delta") {
            const itemId = string(event.item_id) ?? "reasoning";
            const [block, events] = this.startThinking(itemId, this.items.get(itemId) ?? {});
            events.push(...this.appendText(block, string(event.delta) ?? ""));
            return events;
        }
        if (type === "response.reasoning_summary_part.done") {
            return this.stopBlock(this.blocks.get(string(event.item_id) ?? "reasoning"));
        }
        if (type === "response.output_item.done") {
            const item = object(event.item) ?? {};
            return this.synthesizeItem(item);
        }
        if (type === "response.completed" || type === "response.incomplete") {
            return this.finish(object(event.response) ?? {});
        }
        if (type === "response.failed" || type === "error") return this.streamError(event);
        return [];
    }
}
