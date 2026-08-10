import { createParser } from "eventsource-parser";

type SseRecord = {
    sseEvent: string;
    parsed: unknown;
};

const SSE_LOG_TEXT_MAX = 4000;
const TEXT_PREVIEW_MAX = 8000;
const INVALID_JSON_PREVIEW_MAX = 2000;
let isObjectDumpQuiet = false;

export function setObjectDumpQuiet(isQuiet: boolean) {
    isObjectDumpQuiet = isQuiet;
}

export function dumpObject(name: string, info: unknown) {
        if (isObjectDumpQuiet) {
            return;
        }
        try {
            const normalized: Record<string, unknown> = {};
            for (const [key, value] of Object.entries((info ?? {}) as Record<string, unknown>)) {
                normalized[key] = normalizeDumpValue(value);
            }
            console.log(`[ObjectDump::${name}]\n${JSON.stringify(normalized, null, 2)}`);
        } catch (e) {
            console.error(`[ObjectDump] ${name} 打印失败:`, e);
        }
    }

export function timeNow() {
        const d = new Date();
        const pad2 = (n: number) => String(n).padStart(2, "0");
        const pad3 = (n: number) => String(n).padStart(3, "0");
        return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}.${pad3(d.getMilliseconds())}`;
    }

export function maskSecret(secret: string): string {
        if (secret.length <= 10) {
            return secret;
        }
        return `${secret.slice(0, 5)}...${secret.slice(-5)}`;
    }

export function maskHeaderValue(headerName: string, headerValue: string): string {
        const normalizedHeaderName = headerName.toLowerCase();
        if (normalizedHeaderName === "authorization" || normalizedHeaderName === "proxy-authorization") {
            const authParts = headerValue.match(/^(\S+)\s+(.+)$/);
            if (!authParts) {
                return maskSecret(headerValue);
            }
            return `${authParts[1]} ${maskSecret(authParts[2])}`;
        }
        if (normalizedHeaderName === "x-api-key" || normalizedHeaderName === "api-key") {
            return maskSecret(headerValue);
        }
        return headerValue;
    }

export function isSseContentType(contentType: string | null): boolean {
        return (contentType ?? "").toLowerCase().includes("text/event-stream");
    }

export async function readStreamToText(stream: ReadableStream<Uint8Array>): Promise<string> {
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
export function responseBodyForLog(text: string, contentType: string | null): unknown {
        const trimmedText = text.trimStart();
        const isSse = isSseContentType(contentType) || trimmedText.startsWith("event:");
        if (isSse) {
            return summarizeSseForLog(text);
        }
        if (trimmedText.startsWith("{") || trimmedText.startsWith("[")) {
            try {
                const parsed = JSON.parse(text) as Record<string, unknown>;
                const toolCalls = extractToolCallsFromResponse(parsed);
                return toolCalls.length > 0 ? { ...parsed, toolCalls } : parsed;
            } catch {
                return {
                    format: "invalid-json",
                    preview: text.slice(0, INVALID_JSON_PREVIEW_MAX),
                };
            }
        }
        if (text.length > TEXT_PREVIEW_MAX) {
            return {
                format: "text",
                truncated: true,
                byteLength: text.length,
                preview: text.slice(0, TEXT_PREVIEW_MAX),
            };
        }
        return text;
    }

function normalizeDumpValue(value: unknown): unknown {
        if (value instanceof Headers) {
            return Object.fromEntries(
                Array.from(value.entries()).map(([key, item]) => [key, maskHeaderValue(key, item)]),
            );
        }
        if (value && typeof value === "object" && !(value instanceof Array)) {
            return Object.fromEntries(Object.entries(value));
        }
        return value;
    }

    /** SSE 必须以空行结束，避免最后一帧卡在缓冲区 */
function sseBodyWithTerminator(raw: string): string {
        if (raw.endsWith("\n\n")) {
            return raw;
        }
        if (raw.endsWith("\n")) {
            return `${raw}\n`;
        }
        return `${raw}\n\n`;
    }

    /** 解析 SSE 并尽量把 data 反序列化成 JSON */
function parseSseRecords(raw: string): SseRecord[] {
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
        parser.feed(sseBodyWithTerminator(raw));
        return records;
    }

function summarizeSseForLog(raw: string): Record<string, unknown> {
        const records = parseSseRecords(raw);
        const summary = accumulateSseForLog(records);
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
            ...(thinking ? { thinking: truncateForSseLog(thinking) } : {}),
            ...(text ? { assistantText: truncateForSseLog(text) } : {}),
            ...(summary.toolCalls.length > 0 ? { toolCalls: summary.toolCalls.map(tc => ({
                name: tc.name,
                ...(tc.id ? { id: tc.id } : {}),
                input: parseToolInput(tc.inputJson),
            })) } : {}),
            tail: records.slice(-5).map((record) => ({
                sseEvent: record.sseEvent,
                dataType: ssePayloadDataType(record.parsed),
            })),
        };
    }

    /** 扫一遍三种协议的 SSE 帧，只保留日志与统计需要的信息。 */
function accumulateSseForLog(records: SseRecord[]) {
        const sseEventCounts: Record<string, number> = {};
        const dataTypeCounts: Record<string, number> = {};
        let message: Record<string, string> | undefined;
        let usage: Record<string, unknown> | undefined;
        let stopReason: unknown;
        const thinking: string[] = [];
        const text: string[] = [];
        const toolCalls: Array<{ name: string; id?: string; inputJson: string }> = [];
        let currentToolCall: { name: string; id?: string; inputJson: string } | null = null;

        const mergeUsage = (value: unknown) => {
            if (!value || typeof value !== "object" || Array.isArray(value)) return;
            usage = { ...usage, ...value as Record<string, unknown> };
        };

        for (const { sseEvent, parsed } of records) {
            sseEventCounts[sseEvent] = (sseEventCounts[sseEvent] ?? 0) + 1;
            if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) continue;
            const data = parsed as Record<string, unknown>;
            const type = data.type;
            if (typeof type === "string") dataTypeCounts[type] = (dataTypeCounts[type] ?? 0) + 1;

            // Chat Completions carries usage on a final chunk without a typed event.
            mergeUsage(data.usage);
            // Responses carries the authoritative usage inside its terminal response snapshot.
            const terminalResponse = data.response;
            if (terminalResponse && typeof terminalResponse === "object" && !Array.isArray(terminalResponse)) {
                mergeUsage((terminalResponse as Record<string, unknown>).usage);
            }

            switch (type) {
                case "message_start": {
                    const startMessage = data.message;
                    if (!startMessage || typeof startMessage !== "object" || Array.isArray(startMessage)) break;
                    const nextMessage: Record<string, string> = {};
                    const detail = startMessage as Record<string, unknown>;
                    if (typeof detail.id === "string") nextMessage.id = detail.id;
                    if (typeof detail.model === "string") nextMessage.model = detail.model;
                    if (Object.keys(nextMessage).length > 0) message = nextMessage;
                    mergeUsage(detail.usage);
                    break;
                }
                case "message_delta":
                    mergeUsage(data.usage);
                    if (data.stop_reason !== undefined) stopReason = data.stop_reason;
                    if (data.delta && typeof data.delta === "object" && !Array.isArray(data.delta)) {
                        const delta = data.delta as Record<string, unknown>;
                        if (delta.stop_reason !== undefined) stopReason = delta.stop_reason;
                    }
                    break;
                case "message_stop":
                    if (data.stop_reason !== undefined) stopReason = data.stop_reason;
                    break;
                case "content_block_delta": {
                    const delta = data.delta;
                    if (!delta || typeof delta !== "object" || Array.isArray(delta)) break;
                    const detail = delta as Record<string, unknown>;
                    if (detail.type === "thinking_delta" && typeof detail.thinking === "string" && detail.thinking.trim().length > 0) thinking.push(detail.thinking);
                    if (detail.type === "text_delta" && typeof detail.text === "string" && detail.text.trim().length > 0) text.push(detail.text);
                    if (detail.type === "input_json_delta" && typeof detail.partial_json === "string" && currentToolCall) currentToolCall.inputJson += detail.partial_json;
                    break;
                }
                case "content_block_start": {
                    const block = data.content_block;
                    if (block && typeof block === "object" && !Array.isArray(block) && (block as Record<string, unknown>).type === "tool_use") {
                        const detail = block as Record<string, unknown>;
                        currentToolCall = {
                            name: typeof detail.name === "string" ? detail.name : "unknown",
                            ...(typeof detail.id === "string" ? { id: detail.id } : {}),
                            inputJson: "",
                        };
                    }
                    break;
                }
                case "content_block_stop":
                    if (currentToolCall) {
                        toolCalls.push(currentToolCall);
                        currentToolCall = null;
                    }
                    break;
            }
        }

        return { sseEventCounts, dataTypeCounts, message, usage, stopReason, thinking, text, toolCalls };
    }

function truncateForSseLog(text: string): string {
        if (text.length <= SSE_LOG_TEXT_MAX) {
            return text;
        }
        return `${text.slice(0, SSE_LOG_TEXT_MAX)}…(全文${text.length}字，已截断)`;
    }

    /** 解析工具调用参数 JSON，失败则截断原文 */
function parseToolInput(inputJson: string): unknown {
        if (!inputJson) return null;
        try {
            return JSON.parse(inputJson);
        } catch {
            const max = 200;
            return inputJson.length > max ? inputJson.slice(0, max) + "…" : inputJson;
        }
    }

    /** 从已解析的 SSE 摘要或普通 JSON 响应中提取 tool_calls */
function extractToolCallsFromResponse(response: Record<string, unknown>): Array<{ name: string; input: unknown }> {
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

function ssePayloadDataType(parsed: unknown): unknown {
        if (typeof parsed === "object" && parsed !== null && "type" in parsed) {
            return (parsed as { type: unknown }).type;
        }
        return typeof parsed;
    }
