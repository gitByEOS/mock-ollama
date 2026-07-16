import { array, number, object, parseObjectJson, string, type JsonObject } from "./types";
import { ProtocolConversionError } from "./errors";

function textFromContent(content: unknown): string {
    if (typeof content === "string") {
        return content;
    }
    return array(content)
        .map((block) => {
            const detail = object(block);
            if (!detail) return "";
            if (detail.type === "text") return string(detail.text) ?? "";
            if (detail.type === "tool_result") return textFromContent(detail.content);
            return "";
        })
        .join("");
}

function textFromMessageContent(content: unknown): string {
    if (typeof content === "string") {
        return content;
    }
    return array(content)
        .map(object)
        .filter((block): block is JsonObject => block?.type === "text")
        .map((block) => string(block.text) ?? "")
        .join("");
}

export function anthropicStopReason(finishReason: unknown): string {
    switch (finishReason) {
        case "tool_calls":
        case "function_call":
            return "tool_use";
        case "length":
            return "max_tokens";
        case "content_filter":
            return "refusal";
        case "stop":
        default:
            return "end_turn";
    }
}

export function anthropicUsage(usage: unknown): { input_tokens: number; output_tokens: number } {
    const detail = object(usage) ?? {};
    return {
        input_tokens: typeof detail.prompt_tokens === "number" ? detail.prompt_tokens : 0,
        output_tokens: typeof detail.completion_tokens === "number" ? detail.completion_tokens : 0,
    };
}

function systemText(system: unknown): string {
    return textFromMessageContent(system);
}

function convertToolChoice(toolChoice: unknown): unknown {
    const detail = object(toolChoice);
    if (!detail) return undefined;
    switch (detail.type) {
        case "auto":
            return "auto";
        case "any":
            return "required";
        case "tool": {
            const name = string(detail.name);
            return name ? { type: "function", function: { name } } : "required";
        }
        default:
            return undefined;
    }
}

/** Anthropic Messages 请求转换为 OpenAI Chat Completions。 */
export function anthropicRequestToOpenAi(body: JsonObject): JsonObject {
    const messages: JsonObject[] = [];
    const system = systemText(body.system);
    if (system) {
        messages.push({ role: "system", content: system });
    }

    for (const rawMessage of array(body.messages)) {
        const message = object(rawMessage);
        if (!message) continue;
        const role = string(message.role);
        if (role !== "user" && role !== "assistant") continue;
        const content = message.content;
        const blocks = array(content);
        const text = textFromMessageContent(content);
        const toolUses = blocks
            .map(object)
            .filter((block): block is JsonObject => block?.type === "tool_use");

        if (role === "assistant" && toolUses.length > 0) {
            messages.push({
                role: "assistant",
                content: text || null,
                tool_calls: toolUses.map((tool, index) => ({
                    id: string(tool.id) ?? `toolu_${index}`,
                    type: "function",
                    function: {
                        name: string(tool.name) ?? "unknown",
                        arguments: JSON.stringify(object(tool.input) ?? {}),
                    },
                })),
            });
            continue;
        }

        if (text) {
            messages.push({ role, content: text });
        }

        if (role === "user") {
            for (const block of blocks.map(object)) {
                if (block?.type !== "tool_result") continue;
                const toolCallId = string(block.tool_use_id);
                if (!toolCallId) continue;
                messages.push({
                    role: "tool",
                    tool_call_id: toolCallId,
                    content: textFromContent(block.content),
                });
            }
        }
    }

    const tools = array(body.tools)
        .map(object)
        .filter((tool): tool is JsonObject => tool !== null)
        .map((tool) => ({
            type: "function",
            function: {
                name: string(tool.name) ?? "unknown",
                ...(string(tool.description) ? { description: string(tool.description) } : {}),
                parameters: object(tool.input_schema) ?? { type: "object", properties: {} },
            },
        }));
    const toolChoice = convertToolChoice(body.tool_choice);

    return {
        model: body.model,
        messages,
        max_tokens: body.max_tokens,
        ...(typeof body.temperature === "number" ? { temperature: body.temperature } : {}),
        ...(typeof body.top_p === "number" ? { top_p: body.top_p } : {}),
        ...(Array.isArray(body.stop_sequences) ? { stop: body.stop_sequences } : {}),
        ...(tools.length > 0 ? { tools } : {}),
        ...(toolChoice !== undefined ? { tool_choice: toolChoice } : {}),
        ...(body.stream === true ? { stream: true, stream_options: { include_usage: true } } : {}),
    };
}

/** OpenAI Chat Completions 响应转换为 Anthropic Messages 响应。 */
export function openAiResponseToAnthropic(response: JsonObject, request: JsonObject): JsonObject {
    const choice = object(array(response.choices)[0]) ?? {};
    const message = object(choice.message) ?? {};
    const content: JsonObject[] = [];
    const text = string(message.content);
    if (text) {
        content.push({ type: "text", text });
    }
    for (const rawToolCall of array(message.tool_calls)) {
        const toolCall = object(rawToolCall) ?? {};
        const fn = object(toolCall.function) ?? {};
        content.push({
            type: "tool_use",
            id: string(toolCall.id) ?? "toolu_unknown",
            name: string(fn.name) ?? "unknown",
            input: parseObjectJson(fn.arguments),
        });
    }

    return {
        id: string(response.id) ?? `msg_${crypto.randomUUID()}`,
        type: "message",
        role: "assistant",
        model: string(response.model) ?? string(request.model) ?? "unknown",
        content,
        stop_reason: anthropicStopReason(choice.finish_reason),
        stop_sequence: null,
        usage: anthropicUsage(response.usage),
    };
}

export function anthropicResponseToChat(response: JsonObject, request: JsonObject = {}): JsonObject {
    const text: string[] = [];
    const toolCalls: JsonObject[] = [];
    for (const rawBlock of array(response.content)) {
        const block = object(rawBlock);
        if (!block) continue;
        if (block.type === "text") text.push(string(block.text) ?? "");
        if (block.type === "tool_use") {
            toolCalls.push({
                id: string(block.id) ?? "toolu_unknown",
                type: "function",
                function: {
                    name: string(block.name) ?? "unknown",
                    arguments: JSON.stringify(object(block.input) ?? {}),
                },
            });
        }
    }
    const usage = object(response.usage) ?? {};
    const cached = number(usage.cache_read_input_tokens) ?? 0;
    const prompt = (number(usage.input_tokens) ?? 0) + (number(usage.cache_creation_input_tokens) ?? 0) + cached;
    const completion = number(usage.output_tokens) ?? 0;
    const sourceId = string(response.id) ?? crypto.randomUUID().replaceAll("-", "");
    const stopReason = response.stop_reason === "max_tokens"
        ? "length"
        : toolCalls.length > 0 ? "tool_calls" : "stop";
    return {
        id: sourceId.startsWith("chatcmpl-") ? sourceId : `chatcmpl-${sourceId.replace(/^msg_/, "")}`,
        object: "chat.completion",
        created: Math.floor(Date.now() / 1000),
        model: string(response.model) ?? string(request.model) ?? "unknown",
        choices: [{
            index: 0,
            message: {
                role: "assistant",
                content: text.join("") || null,
                ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
            },
            finish_reason: stopReason,
        }],
        usage: {
            prompt_tokens: prompt,
            completion_tokens: completion,
            total_tokens: prompt + completion,
            prompt_tokens_details: { cached_tokens: cached },
        },
    };
}

function chatPartToAnthropic(rawPart: unknown): JsonObject[] {
    if (typeof rawPart === "string") return [{ type: "text", text: rawPart }];
    const part = object(rawPart);
    if (!part) return [];
    if (part.type === "text" || part.type === "input_text" || part.type === "output_text") {
        return [{ type: "text", text: string(part.text) ?? "" }];
    }
    if (part.type === "image_url") {
        const url = typeof part.image_url === "string" ? part.image_url : string(object(part.image_url)?.url);
        if (!url) return [];
        const data = /^data:([^;,]+);base64,(.*)$/s.exec(url);
        return [{
            type: "image",
            source: data
                ? { type: "base64", media_type: data[1], data: data[2] }
                : { type: "url", url },
        }];
    }
    if (part.type === "file") {
        const file = object(part.file) ?? {};
        if (string(file.file_id)) return [{ type: "document", source: { type: "file", file_id: file.file_id } }];
        const fileData = string(file.file_data);
        const data = fileData ? /^data:([^;,]+);base64,(.*)$/s.exec(fileData) : null;
        if (data) return [{
            type: "document",
            source: { type: "base64", media_type: data[1], data: data[2] },
            ...(string(file.filename) ? { title: file.filename } : {}),
        }];
    }
    return [];
}

function chatContentText(content: unknown): string {
    if (typeof content === "string") return content;
    return array(content)
        .flatMap(chatPartToAnthropic)
        .filter((part) => part.type === "text")
        .map((part) => string(part.text) ?? "")
        .join("");
}

/** OpenAI Chat 请求直转 Anthropic Messages 请求，不借道 Responses。 */
export function chatRequestToAnthropic(body: JsonObject): JsonObject {
    if (number(body.n) !== undefined && body.n !== 1) {
        throw new ProtocolConversionError("Anthropic Messages API does not support Chat n > 1", 400, "n");
    }

    const system: string[] = [];
    const messages: JsonObject[] = [];
    for (const rawMessage of array(body.messages)) {
        const message = object(rawMessage);
        const role = string(message?.role);
        if (!message || !role) continue;
        if (role === "system" || role === "developer") {
            const text = chatContentText(message.content);
            if (text) system.push(text);
            continue;
        }
        if (role === "tool") {
            messages.push({
                role: "user",
                content: [{
                    type: "tool_result",
                    tool_use_id: string(message.tool_call_id) ?? "",
                    content: chatContentText(message.content),
                }],
            });
            continue;
        }
        if (role !== "user" && role !== "assistant") continue;
        const content = typeof message.content === "string"
            ? chatPartToAnthropic(message.content)
            : array(message.content).flatMap(chatPartToAnthropic);
        if (role === "assistant") {
            for (const rawCall of array(message.tool_calls)) {
                const call = object(rawCall) ?? {};
                const fn = object(call.function) ?? {};
                content.push({
                    type: "tool_use",
                    id: string(call.id) ?? `call_${messages.length}_${content.length}`,
                    name: string(fn.name) ?? "unknown",
                    input: parseObjectJson(fn.arguments),
                });
            }
        }
        if (content.length > 0) messages.push({ role, content });
    }

    const result: JsonObject = {
        model: body.model,
        messages,
        max_tokens: number(body.max_completion_tokens) ?? number(body.max_tokens) ?? 4096,
        stream: body.stream === true,
    };
    if (system.length > 0) result.system = system.join("\n");
    for (const field of ["temperature", "top_p", "service_tier"] as const) {
        if (body[field] !== undefined) result[field] = body[field];
    }
    if (typeof body.stop === "string") result.stop_sequences = [body.stop];
    if (Array.isArray(body.stop)) result.stop_sequences = body.stop;
    if (string(body.reasoning_effort)) {
        result.thinking = { type: "adaptive" };
        result.output_config = { effort: body.reasoning_effort };
    }

    const tools = array(body.tools).flatMap((rawTool): JsonObject[] => {
        const tool = object(rawTool);
        const fn = object(tool?.function);
        if (!tool || tool.type !== "function" || !fn) return [];
        return [{
            name: string(fn.name) ?? "unknown",
            ...(string(fn.description) ? { description: fn.description } : {}),
            input_schema: object(fn.parameters) ?? { type: "object", properties: {} },
        }];
    });
    if (tools.length > 0 && body.tool_choice !== "none") result.tools = tools;
    if (body.tool_choice === "auto") result.tool_choice = { type: "auto" };
    if (body.tool_choice === "required") result.tool_choice = { type: "any" };
    const choice = object(body.tool_choice);
    if (choice?.type === "function") {
        result.tool_choice = { type: "tool", name: string(object(choice.function)?.name) ?? "" };
    }
    if (string(body.user)) result.metadata = { user_id: body.user };
    return Object.fromEntries(Object.entries(result).filter(([, value]) => value !== undefined));
}



export const anthropicRequestToChat = anthropicRequestToOpenAi;
export const chatResponseToAnthropic = openAiResponseToAnthropic;
