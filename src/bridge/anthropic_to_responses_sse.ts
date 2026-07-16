import { integer, number, object, string, type JsonObject } from "./types";
import { gptSignature, anthropicUsageToResponses, responseStatus, responsesId, stableCallId } from "./anthropic_responses_shared";
import { parseSseJson, protocolEvent, type ProtocolEvent } from "./responses_sse_common";

type AnthropicStreamBlock = {
    index: number;
    kind: "text" | "tool" | "thinking";
    outputIndex: number;
    item: JsonObject;
    text: string;
    arguments: string;
    signature?: string;
    isOpen: boolean;
    isStopped: boolean;
};

export class AnthropicToResponsesSseState {
    private sequence = 0;
    private responseId = "";
    private createdAt = 0;
    private model = "unknown";
    private output: JsonObject[] = [];
    private blocks = new Map<number, AnthropicStreamBlock>();
    private usage: JsonObject = {};
    private stopReason: unknown = "end_turn";
    private isStarted = false;
    private isTerminal = false;

    constructor(
        private readonly request: JsonObject = {},
        private readonly now: () => number = () => Math.floor(Date.now() / 1000),
    ) {}

    private emit(event: string, data: JsonObject): ProtocolEvent {
        return protocolEvent(event, { sequence_number: ++this.sequence, ...data });
    }

    private reset(message: JsonObject) {
        this.sequence = 0;
        this.responseId = responsesId(message.id);
        this.createdAt = this.now();
        this.model = string(message.model) ?? string(this.request.model) ?? "unknown";
        this.output = [];
        this.blocks.clear();
        this.usage = object(message.usage) ?? {};
        this.stopReason = "end_turn";
        this.isStarted = true;
        this.isTerminal = false;
    }

    private startEvents(message: JsonObject): ProtocolEvent[] {
        this.reset(message);
        const base = {
            id: this.responseId,
            object: "response",
            created_at: this.createdAt,
            model: this.model,
            status: "in_progress",
        };
        return [
            this.emit("response.created", { response: { ...base, output: [] } }),
            this.emit("response.in_progress", { response: base }),
        ];
    }

    private ensureStarted(): ProtocolEvent[] {
        return this.isStarted ? [] : this.startEvents({ model: this.request.model });
    }

    private openThinking(block: AnthropicStreamBlock): ProtocolEvent[] {
        if (block.isOpen || !block.signature) return [];
        block.outputIndex = this.output.length;
        block.item = {
            id: `rs_${this.responseId}_${block.index}`,
            type: "reasoning",
            status: "in_progress",
            encrypted_content: block.signature,
            summary: [],
        };
        block.isOpen = true;
        this.output.push(block.item);
        const events = [
            this.emit("response.output_item.added", {
                output_index: block.outputIndex,
                item: { ...block.item },
            }),
            this.emit("response.reasoning_summary_part.added", {
                item_id: block.item.id,
                output_index: block.outputIndex,
                summary_index: 0,
                part: { type: "summary_text", text: "" },
            }),
        ];
        if (block.text) {
            events.push(this.emit("response.reasoning_summary_text.delta", {
                item_id: block.item.id,
                output_index: block.outputIndex,
                summary_index: 0,
                delta: block.text,
            }));
        }
        return events;
    }

    private startBlock(index: number, content: JsonObject): ProtocolEvent[] {
        const events = this.ensureStarted();
        if (this.blocks.has(index)) return events;
        const kind = content.type === "tool_use"
            ? "tool"
            : content.type === "thinking"
                ? "thinking"
                : "text";
        const block: AnthropicStreamBlock = {
            index,
            kind,
            outputIndex: -1,
            item: {},
            text: string(content.text) ?? string(content.thinking) ?? "",
            arguments: "",
            signature: kind === "thinking" ? gptSignature(content.signature) : undefined,
            isOpen: false,
            isStopped: false,
        };
        this.blocks.set(index, block);
        if (kind === "thinking") {
            events.push(...this.openThinking(block));
            return events;
        }

        block.outputIndex = this.output.length;
        if (kind === "tool") {
            const callId = string(content.id) ?? stableCallId(0, index, string(content.name) ?? "unknown");
            block.item = {
                id: `fc_${callId}`,
                type: "function_call",
                status: "in_progress",
                arguments: "",
                call_id: callId,
                name: string(content.name) ?? "unknown",
            };
            block.isOpen = true;
            this.output.push(block.item);
            events.push(this.emit("response.output_item.added", {
                output_index: block.outputIndex,
                item: { ...block.item },
            }));
            return events;
        }

        block.item = {
            id: `msg_${this.responseId}_${index}`,
            type: "message",
            status: "in_progress",
            role: "assistant",
            content: [],
        };
        block.isOpen = true;
        this.output.push(block.item);
        events.push(
            this.emit("response.output_item.added", {
                output_index: block.outputIndex,
                item: { ...block.item },
            }),
            this.emit("response.content_part.added", {
                item_id: block.item.id,
                output_index: block.outputIndex,
                content_index: 0,
                part: { type: "output_text", text: "", annotations: [] },
            }),
        );
        return events;
    }

    private deltaBlock(index: number, delta: JsonObject): ProtocolEvent[] {
        const block = this.blocks.get(index);
        if (!block || block.isStopped) return [];
        if (delta.type === "signature_delta") {
            block.signature = gptSignature(delta.signature);
            return this.openThinking(block);
        }
        if (delta.type === "thinking_delta") {
            const text = string(delta.thinking) ?? "";
            block.text += text;
            if (!block.isOpen || !text) return [];
            return [this.emit("response.reasoning_summary_text.delta", {
                item_id: block.item.id,
                output_index: block.outputIndex,
                summary_index: 0,
                delta: text,
            })];
        }
        if (delta.type === "input_json_delta") {
            const fragment = string(delta.partial_json) ?? "";
            block.arguments += fragment;
            if (!fragment) return [];
            return [this.emit("response.function_call_arguments.delta", {
                item_id: block.item.id,
                output_index: block.outputIndex,
                delta: fragment,
            })];
        }
        const text = string(delta.text) ?? "";
        block.text += text;
        if (!text) return [];
        return [this.emit("response.output_text.delta", {
            item_id: block.item.id,
            output_index: block.outputIndex,
            content_index: 0,
            delta: text,
        })];
    }

    private stopBlock(block: AnthropicStreamBlock): ProtocolEvent[] {
        if (block.isStopped) return [];
        if (block.kind === "thinking" && !block.isOpen) {
            block.isStopped = true;
            return [];
        }
        block.isStopped = true;
        if (block.kind === "tool") {
            const argumentsText = block.arguments || "{}";
            block.item.arguments = argumentsText;
            block.item.status = "completed";
            return [
                this.emit("response.function_call_arguments.done", {
                    item_id: block.item.id,
                    output_index: block.outputIndex,
                    arguments: argumentsText,
                }),
                this.emit("response.output_item.done", {
                    output_index: block.outputIndex,
                    item: { ...block.item },
                }),
            ];
        }
        if (block.kind === "thinking") {
            block.item.status = "completed";
            block.item.encrypted_content = block.signature;
            block.item.summary = block.text ? [{ type: "summary_text", text: block.text }] : [];
            return [
                this.emit("response.reasoning_summary_text.done", {
                    item_id: block.item.id,
                    output_index: block.outputIndex,
                    summary_index: 0,
                    text: block.text,
                }),
                this.emit("response.reasoning_summary_part.done", {
                    item_id: block.item.id,
                    output_index: block.outputIndex,
                    summary_index: 0,
                    part: { type: "summary_text", text: block.text },
                }),
                this.emit("response.output_item.done", {
                    output_index: block.outputIndex,
                    item: { ...block.item },
                }),
            ];
        }
        const part = { type: "output_text", text: block.text, annotations: [] };
        block.item.status = "completed";
        block.item.content = [part];
        return [
            this.emit("response.output_text.done", {
                item_id: block.item.id,
                output_index: block.outputIndex,
                content_index: 0,
                text: block.text,
            }),
            this.emit("response.content_part.done", {
                item_id: block.item.id,
                output_index: block.outputIndex,
                content_index: 0,
                part,
            }),
            this.emit("response.output_item.done", {
                output_index: block.outputIndex,
                item: { ...block.item },
            }),
        ];
    }

    private mergeUsage(value: unknown) {
        const next = object(value);
        if (!next) return;
        for (const field of [
            "input_tokens",
            "output_tokens",
            "cache_creation_input_tokens",
            "cache_read_input_tokens",
        ]) {
            if (number(next[field]) !== undefined) this.usage[field] = next[field];
        }
    }

    fail(message = "Upstream stream ended without message_stop"): ProtocolEvent[] {
        return this.push({ type: "error", error: { type: "api_error", message } });
    }

    get terminal(): boolean {
        return this.isTerminal;
    }

    push(event: JsonObject): ProtocolEvent[] {
        if (this.isTerminal) return [];
        const type = string(event.type);
        if (type === "message_start") return this.startEvents(object(event.message) ?? {});
        if (type === "content_block_start") {
            return this.startBlock(integer(event.index) ?? 0, object(event.content_block) ?? {});
        }
        if (type === "content_block_delta") {
            return this.deltaBlock(integer(event.index) ?? 0, object(event.delta) ?? {});
        }
        if (type === "content_block_stop") {
            const block = this.blocks.get(integer(event.index) ?? 0);
            return block ? this.stopBlock(block) : [];
        }
        if (type === "message_delta") {
            this.mergeUsage(event.usage);
            this.stopReason = object(event.delta)?.stop_reason ?? this.stopReason;
            return [];
        }
        if (type === "error") {
            const error = object(event.error) ?? { type: "api_error", message: "Upstream stream failed" };
            const events = this.ensureStarted();
            events.push(
                this.emit("response.failed", {
                    response: {
                        id: this.responseId,
                        object: "response",
                        created_at: this.createdAt,
                        model: this.model,
                        status: "failed",
                        output: this.output,
                        error,
                    },
                }),
                this.emit("error", { error }),
            );
            this.isTerminal = true;
            return events;
        }
        if (type !== "message_stop") return [];

        const events = this.ensureStarted();
        for (const block of [...this.blocks.values()].sort((left, right) => left.index - right.index)) {
            events.push(...this.stopBlock(block));
        }
        const usage = anthropicUsageToResponses(this.usage);
        const status = responseStatus(this.stopReason);
        events.push(this.emit(status.status === "incomplete" ? "response.incomplete" : "response.completed", {
            response: {
                id: this.responseId,
                object: "response",
                created_at: this.createdAt,
                model: this.model,
                ...status,
                output: this.output,
                usage,
            },
        }));
        this.isTerminal = true;
        return events;
    }
}
