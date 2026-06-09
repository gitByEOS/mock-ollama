import { createParser } from "eventsource-parser";

type SseRecord = {
    sseEvent: string;
    parsed: unknown;
};

export class Utils {
    private static readonly SSE_LOG_TEXT_MAX = 4000;
    private static readonly TEXT_PREVIEW_MAX = 8000;
    private static readonly INVALID_JSON_PREVIEW_MAX = 2000;
    private static isObjectDumpQuiet = false;

    static setObjectDumpQuiet(isQuiet: boolean) {
        this.isObjectDumpQuiet = isQuiet;
    }

    static dumpObject(name: string, info: unknown) {
        if (this.isObjectDumpQuiet) {
            return;
        }
        try {
            const normalized: Record<string, unknown> = {};
            for (const [key, value] of Object.entries((info ?? {}) as Record<string, unknown>)) {
                normalized[key] = this.normalizeDumpValue(value);
            }
            console.log(`[ObjectDump::${name}]\n${JSON.stringify(normalized, null, 2)}`);
        } catch (e) {
            console.error(`[ObjectDump] ${name} 打印失败:`, e);
        }
    }

    static timeNow() {
        const d = new Date();
        const pad2 = (n: number) => String(n).padStart(2, "0");
        const pad3 = (n: number) => String(n).padStart(3, "0");
        return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}.${pad3(d.getMilliseconds())}`;
    }

    static maskSecret(secret: string): string {
        if (secret.length <= 10) {
            return secret;
        }
        return `${secret.slice(0, 5)}...${secret.slice(-5)}`;
    }

    static maskHeaderValue(headerName: string, headerValue: string): string {
        const normalizedHeaderName = headerName.toLowerCase();
        if (normalizedHeaderName === "authorization" || normalizedHeaderName === "proxy-authorization") {
            const authParts = headerValue.match(/^(\S+)\s+(.+)$/);
            if (!authParts) {
                return this.maskSecret(headerValue);
            }
            return `${authParts[1]} ${this.maskSecret(authParts[2])}`;
        }
        if (normalizedHeaderName === "x-api-key" || normalizedHeaderName === "api-key") {
            return this.maskSecret(headerValue);
        }
        return headerValue;
    }

    static isSseContentType(contentType: string | null): boolean {
        return (contentType ?? "").toLowerCase().includes("text/event-stream");
    }

    static async readStreamToText(stream: ReadableStream<Uint8Array>): Promise<string> {
        const reader = stream.getReader();
        const decoder = new TextDecoder();
        let text = "";
        try {
            while (true) {
                const { done, value } = await reader.read();
                if (done) {
                    break;
                }
                text += decoder.decode(value, { stream: true });
            }
            text += decoder.decode();
            return text;
        } finally {
            reader.releaseLock();
        }
    }

    /** 把上游正文转成日志结构 */
    static responseBodyForLog(text: string, contentType: string | null): unknown {
        const trimmedText = text.trimStart();
        const isSse = this.isSseContentType(contentType) || trimmedText.startsWith("event:");
        if (isSse) {
            return this.summarizeSseForLog(text);
        }
        if (trimmedText.startsWith("{") || trimmedText.startsWith("[")) {
            try {
                const parsed = JSON.parse(text) as Record<string, unknown>;
                const toolCalls = this.extractToolCallsFromResponse(parsed);
                return toolCalls.length > 0 ? { ...parsed, toolCalls } : parsed;
            } catch {
                return {
                    format: "invalid-json",
                    preview: text.slice(0, this.INVALID_JSON_PREVIEW_MAX),
                };
            }
        }
        if (text.length > this.TEXT_PREVIEW_MAX) {
            return {
                format: "text",
                truncated: true,
                byteLength: text.length,
                preview: text.slice(0, this.TEXT_PREVIEW_MAX),
            };
        }
        return text;
    }

    private static normalizeDumpValue(value: unknown): unknown {
        if (value instanceof Headers) {
            return Object.fromEntries(
                Array.from(value.entries()).map(([key, item]) => [key, this.maskHeaderValue(key, item)]),
            );
        }
        if (value && typeof value === "object" && !(value instanceof Array)) {
            return Object.fromEntries(Object.entries(value));
        }
        return value;
    }

    /** SSE 必须以空行结束，避免最后一帧卡在缓冲区 */
    private static sseBodyWithTerminator(raw: string): string {
        if (raw.endsWith("\n\n")) {
            return raw;
        }
        if (raw.endsWith("\n")) {
            return `${raw}\n`;
        }
        return `${raw}\n\n`;
    }

    /** 解析 SSE 并尽量把 data 反序列化成 JSON */
    private static parseSseRecords(raw: string): SseRecord[] {
        const records: SseRecord[] = [];
        const parser = createParser({
            onEvent: (message) => {
                let parsed: unknown = message.data;
                try {
                    parsed = JSON.parse(message.data);
                } catch {
                    // 保留原始字符串，比如 [DONE]
                }
                records.push({
                    sseEvent: message.event ?? "message",
                    parsed,
                });
            },
        });
        parser.feed(this.sseBodyWithTerminator(raw));
        return records;
    }

    private static summarizeSseForLog(raw: string): Record<string, unknown> {
        const records = this.parseSseRecords(raw);
        const summary = this.accumulateSseForAnthropicLog(records);
        const thinking = summary.thinking.join("");
        const text = summary.text.join("");
        return {
            format: "sse",
            byteLength: Buffer.byteLength(raw, "utf8"),
            frameCount: records.length,
            sseEventCounts: summary.sseEventCounts,
            dataTypeCounts: summary.dataTypeCounts,
            ...(summary.message ? { message: summary.message } : {}),
            ...(summary.usage !== undefined ? { usage: summary.usage } : {}),
            ...(summary.stopReason !== undefined ? { stopReason: summary.stopReason } : {}),
            ...(thinking ? { thinking: this.truncateForSseLog(thinking) } : {}),
            ...(text ? { assistantText: this.truncateForSseLog(text) } : {}),
            ...(summary.toolCalls.length > 0 ? { toolCalls: summary.toolCalls.map(tc => ({
                name: tc.name,
                ...(tc.id ? { id: tc.id } : {}),
                input: this.parseToolInput(tc.inputJson),
            })) } : {}),
            tail: records.slice(-5).map((record) => ({
                sseEvent: record.sseEvent,
                dataType: this.ssePayloadDataType(record.parsed),
            })),
        };
    }

    /** 扫一遍 SSE 帧，只保留日志需要的信息 */
    private static accumulateSseForAnthropicLog(records: SseRecord[]) {
        const sseEventCounts: Record<string, number> = {};
        const dataTypeCounts: Record<string, number> = {};
        let message: Record<string, string> | undefined;
        let usage: unknown;
        let stopReason: unknown;
        const thinking: string[] = [];
        const text: string[] = [];
        const toolCalls: Array<{ name: string; id?: string; inputJson: string }> = [];
        let currentToolCall: { name: string; id?: string; inputJson: string } | null = null;

        for (const { sseEvent, parsed } of records) {
            sseEventCounts[sseEvent] = (sseEventCounts[sseEvent] ?? 0) + 1;
            if (typeof parsed !== "object" || parsed === null) {
                continue;
            }
            const data = parsed as Record<string, unknown>;
            const type = data.type;
            if (typeof type === "string") {
                dataTypeCounts[type] = (dataTypeCounts[type] ?? 0) + 1;
            }
            switch (type) {
                case "message_start": {
                    const startMessage = data.message;
                    if (!startMessage || typeof startMessage !== "object") {
                        break;
                    }
                    const nextMessage: Record<string, string> = {};
                    const detail = startMessage as Record<string, unknown>;
                    if (typeof detail.id === "string") {
                        nextMessage.id = detail.id;
                    }
                    if (typeof detail.model === "string") {
                        nextMessage.model = detail.model;
                    }
                    if (Object.keys(nextMessage).length > 0) {
                        message = nextMessage;
                    }
                    break;
                }
                case "message_delta":
                    if (data.usage !== undefined) {
                        usage = data.usage;
                    }
                    break;
                case "message_stop":
                    if (data.stop_reason !== undefined) {
                        stopReason = data.stop_reason;
                    }
                    break;
                case "content_block_delta": {
                    const delta = data.delta;
                    if (!delta || typeof delta !== "object") {
                        break;
                    }
                    const detail = delta as Record<string, unknown>;
                    if (detail.type === "thinking_delta" && typeof detail.thinking === "string" && detail.thinking.trim().length > 0) {
                        thinking.push(detail.thinking);
                    }
                    if (detail.type === "text_delta" && typeof detail.text === "string" && detail.text.trim().length > 0) {
                        text.push(detail.text);
                    }
                    if (detail.type === "input_json_delta" && typeof detail.partial_json === "string" && currentToolCall) {
                        currentToolCall.inputJson += detail.partial_json;
                    }
                    break;
                }
                case "content_block_start": {
                    const block = data.content_block;
                    if (block && typeof block === "object" && (block as Record<string, unknown>).type === "tool_use") {
                        const detail = block as Record<string, unknown>;
                        currentToolCall = {
                            name: typeof detail.name === "string" ? detail.name : "unknown",
                            ...(typeof detail.id === "string" ? { id: detail.id } : {}),
                            inputJson: "",
                        };
                    }
                    break;
                }
                case "content_block_stop": {
                    if (currentToolCall) {
                        toolCalls.push(currentToolCall);
                        currentToolCall = null;
                    }
                    break;
                }
            }
        }

        return { sseEventCounts, dataTypeCounts, message, usage, stopReason, thinking, text, toolCalls };
    }

    private static truncateForSseLog(text: string): string {
        if (text.length <= this.SSE_LOG_TEXT_MAX) {
            return text;
        }
        return `${text.slice(0, this.SSE_LOG_TEXT_MAX)}…(全文${text.length}字，已截断)`;
    }

    /** 解析工具调用参数 JSON，失败则截断原文 */
    private static parseToolInput(inputJson: string): unknown {
        if (!inputJson) return null;
        try {
            return JSON.parse(inputJson);
        } catch {
            const max = 200;
            return inputJson.length > max ? inputJson.slice(0, max) + "…" : inputJson;
        }
    }

    /** 从已解析的 SSE 摘要或普通 JSON 响应中提取 tool_calls */
    private static extractToolCallsFromResponse(response: Record<string, unknown>): Array<{ name: string; input: unknown }> {
        // SSE 格式已带 toolCalls，直接返回
        if (Array.isArray(response.toolCalls)) {
            return response.toolCalls as Array<{ name: string; input: unknown }>;
        }
        // OpenAI 兼容：choices[0].message.tool_calls
        const choices = response.choices;
        if (Array.isArray(choices) && choices.length > 0) {
            const msg = (choices[0] as Record<string, unknown>)?.message;
            if (msg && Array.isArray((msg as Record<string, unknown>).tool_calls)) {
                return ((msg as Record<string, unknown>).tool_calls as Array<Record<string, unknown>>)
                    .map(tc => {
                        const fn = (tc.function ?? tc) as Record<string, unknown>;
                        let input: unknown = fn.arguments;
                        if (typeof input === "string") {
                            try { input = JSON.parse(input); } catch { /* keep raw */ }
                        }
                        return { name: String(fn.name ?? "unknown"), input };
                    });
            }
        }
        // Anthropic 非流式：content[].type === "tool_use"
        const content = response.content;
        if (Array.isArray(content)) {
            return content
                .filter(b => b && typeof b === "object" && (b as Record<string, unknown>).type === "tool_use")
                .map(b => {
                    const block = b as Record<string, unknown>;
                    return { name: String(block.name ?? "unknown"), input: block.input ?? null };
                });
        }
        return [];
    }

    private static ssePayloadDataType(parsed: unknown): unknown {
        if (typeof parsed === "object" && parsed !== null && "type" in parsed) {
            return (parsed as { type: unknown }).type;
        }
        return typeof parsed;
    }
}
