import { array, number, object, string, type JsonObject } from "./types";

export function compactJson(value: unknown): string {
    return JSON.stringify(object(value) ?? {});
}

export function stableCallId(messageIndex: number, blockIndex: number, name: string): string {
    const text = `${messageIndex}:${blockIndex}:${name}`;
    let hash = 2166136261;
    for (let index = 0; index < text.length; index++) {
        hash ^= text.charCodeAt(index);
        hash = Math.imul(hash, 16777619);
    }
    return `call_${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

export function stripProviderPrefix(signature: string, providers: string[]): string | undefined {
    const trimmed = signature.trim();
    const separator = trimmed.indexOf("#");
    if (separator < 0) return trimmed;
    const provider = trimmed.slice(0, separator).toLowerCase();
    return providers.includes(provider) ? trimmed.slice(separator + 1).trim() : undefined;
}

export function isBase64(value: string, isUrlSafe = false): boolean {
    if (!value || value.length > 32 * 1024 * 1024) return false;
    const pattern = isUrlSafe ? /^[A-Za-z0-9_=-]+$/ : /^[A-Za-z0-9+/=]+$/;
    if (!pattern.test(value)) return false;
    try {
        Buffer.from(value, isUrlSafe ? "base64url" : "base64");
        return true;
    } catch {
        return false;
    }
}

export function gptSignature(value: unknown): string | undefined {
    if (typeof value !== "string") return undefined;
    const signature = stripProviderPrefix(value, ["openai", "gpt", "codex"]);
    return signature?.startsWith("gAAAA") && isBase64(signature, true) ? signature : undefined;
}

export function claudeSignature(value: unknown): string | undefined {
    if (typeof value !== "string") return undefined;
    const signature = stripProviderPrefix(value, ["claude", "anthropic"]);
    return signature && (signature.startsWith("E") || signature.startsWith("R")) && isBase64(signature)
        ? signature
        : undefined;
}

export function systemText(value: unknown): string {
    if (typeof value === "string") return value;
    return array(value)
        .map(object)
        .filter((block): block is JsonObject => block?.type === "text")
        .map((block) => string(block.text) ?? "")
        .filter(Boolean)
        .join("\n");
}

export function anthropicImageToResponses(block: JsonObject): JsonObject | undefined {
    const source = object(block.source) ?? {};
    if (source.type === "url" && string(source.url)) {
        return { type: "input_image", image_url: source.url };
    }
    if (source.type === "base64" && string(source.data)) {
        const mediaType = string(source.media_type) ?? "application/octet-stream";
        return { type: "input_image", image_url: `data:${mediaType};base64,${source.data}` };
    }
    return undefined;
}

export function anthropicDocumentToResponses(block: JsonObject): JsonObject | undefined {
    const source = object(block.source) ?? {};
    if (string(source.file_id)) return { type: "input_file", file_id: source.file_id };
    if (source.type === "url" && string(source.url)) return { type: "input_file", file_url: source.url };
    if (source.type === "base64" && string(source.data)) {
        const mediaType = string(source.media_type) ?? "application/octet-stream";
        return {
            type: "input_file",
            file_data: `data:${mediaType};base64,${source.data}`,
            ...(string(block.title) ? { filename: block.title } : {}),
        };
    }
    return undefined;
}

export function responsesImageToAnthropic(part: JsonObject): JsonObject | undefined {
    const url = string(part.image_url) ?? string(part.url);
    if (!url) return undefined;
    const match = /^data:([^;,]+);base64,(.*)$/s.exec(url);
    if (match) {
        return { type: "image", source: { type: "base64", media_type: match[1], data: match[2] } };
    }
    return { type: "image", source: { type: "url", url } };
}

export function responsesFileToAnthropic(part: JsonObject): JsonObject | undefined {
    if (string(part.file_id)) {
        return { type: "document", source: { type: "file", file_id: part.file_id } };
    }
    if (string(part.file_url)) {
        return { type: "document", source: { type: "url", url: part.file_url } };
    }
    const data = string(part.file_data);
    if (!data) return undefined;
    const match = /^data:([^;,]+);base64,(.*)$/s.exec(data);
    if (!match) return undefined;
    return { type: "document", source: { type: "base64", media_type: match[1], data: match[2] } };
}

export function normalizeSchema(value: unknown): unknown {
    const schema = object(value);
    if (!schema) return value;
    if (schema.type === "object" && object(schema.properties) === null) {
        return { ...schema, properties: {} };
    }
    return schema;
}

export function anthropicReasoningEffort(body: JsonObject): string | undefined {
    const thinking = object(body.thinking);
    if (!thinking) return undefined;
    switch (thinking.type) {
        case "disabled":
            return "none";
        case "adaptive":
        case "auto":
            return string(object(body.output_config)?.effort) ?? "auto";
        case "enabled": {
            const budget = number(thinking.budget_tokens);
            if (budget === undefined || budget < 2048) return "minimal";
            if (budget < 4096) return "low";
            if (budget < 8192) return "medium";
            if (budget < 16384) return "high";
            return "xhigh";
        }
        default:
            return undefined;
    }
}

export function isReasoningModel(model: unknown): boolean {
    const normalized = string(model)?.toLowerCase();
    return normalized?.startsWith("gpt-5.6-") === true
        || normalized?.startsWith("o1") === true
        || normalized?.startsWith("o3") === true;
}

export function reasoningEffortToAnthropic(value: unknown): JsonObject {
    const effort = string(object(value)?.effort);
    if (!effort) return {};
    if (effort === "none") return { thinking: { type: "disabled" } };
    if (effort === "auto") return { thinking: { type: "adaptive" } };
    return { thinking: { type: "adaptive" }, output_config: { effort } };
}

export function anthropicToolResultOutput(content: unknown): unknown {
    if (typeof content === "string") return content;
    const parts = array(content).flatMap((rawPart): JsonObject[] => {
        if (typeof rawPart === "string") return [{ type: "input_text", text: rawPart }];
        const part = object(rawPart);
        if (!part) return [];
        if (part.type === "text") return [{ type: "input_text", text: string(part.text) ?? "" }];
        if (part.type === "image") {
            const image = anthropicImageToResponses(part);
            return image ? [image] : [];
        }
        if (part.type === "document") {
            const file = anthropicDocumentToResponses(part);
            return file ? [file] : [];
        }
        return [];
    });
    return parts.length === 1 && parts[0].type === "input_text" ? parts[0].text : parts;
}

export function responsesToolOutputContent(output: unknown): unknown {
    if (typeof output === "string") return output;
    return array(output).flatMap((rawPart): JsonObject[] => {
        const part = object(rawPart);
        if (!part) return [];
        if (part.type === "input_text" || part.type === "output_text") {
            return [{ type: "text", text: string(part.text) ?? "" }];
        }
        if (part.type === "input_image") {
            const image = responsesImageToAnthropic(part);
            return image ? [image] : [];
        }
        if (part.type === "input_file") {
            const file = responsesFileToAnthropic(part);
            return file ? [file] : [];
        }
        return [];
    });
}

/** Anthropic Messages 请求直转 OpenAI Responses 请求。 */
export function anthropicUsageToResponses(value: unknown): JsonObject {
    const usage = object(value) ?? {};
    const input = number(usage.input_tokens) ?? 0;
    const cacheCreation = number(usage.cache_creation_input_tokens) ?? 0;
    const cached = number(usage.cache_read_input_tokens) ?? 0;
    const output = number(usage.output_tokens) ?? 0;
    const inputTokens = input + cacheCreation + cached;
    return {
        input_tokens: inputTokens,
        input_tokens_details: { cached_tokens: cached },
        output_tokens: output,
        total_tokens: inputTokens + output,
    };
}

export function responsesUsageToAnthropic(value: unknown): JsonObject {
    const usage = object(value) ?? {};
    const totalInput = number(usage.input_tokens) ?? 0;
    const cached = number(object(usage.input_tokens_details)?.cached_tokens) ?? 0;
    return {
        input_tokens: Math.max(0, totalInput - cached),
        output_tokens: number(usage.output_tokens) ?? 0,
        ...(cached > 0 ? { cache_read_input_tokens: cached } : {}),
    };
}

export function responsesStopReason(response: JsonObject, hasTool: boolean): string {
    if (hasTool) return "tool_use";
    if (object(response.incomplete_details)?.reason === "max_output_tokens") return "max_tokens";
    return "end_turn";
}

export function responseStatus(stopReason: unknown): JsonObject {
    if (stopReason === "max_tokens") {
        return { status: "incomplete", incomplete_details: { reason: "max_output_tokens" } };
    }
    return { status: "completed" };
}

export function claudeMessageId(responseId: unknown): string {
    const id = string(responseId) ?? crypto.randomUUID().replaceAll("-", "");
    if (id.startsWith("msg_")) return id;
    return `msg_${id.replace(/^resp_/, "")}`;
}

export function responsesId(messageId: unknown): string {
    const id = string(messageId) ?? crypto.randomUUID().replaceAll("-", "");
    if (id.startsWith("resp_")) return id;
    return `resp_${id.replace(/^msg_/, "")}`;
}

export function responseReasoningSummary(item: JsonObject): string {
    if (typeof item.summary === "string") return item.summary;
    return array(item.summary)
        .map(object)
        .filter((part): part is JsonObject => part !== null)
        .map((part) => string(part.text) ?? "")
        .join("");
}

/** OpenAI Responses 普通响应转换为 Anthropic Messages 响应。 */
