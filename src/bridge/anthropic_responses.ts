import { array, integer, number, object, parseObjectJson, string, type JsonObject } from "./types";
import { ProtocolConversionError } from "./errors";
import {
    compactJson,
    stableCallId,
    stripProviderPrefix,
    isBase64,
    gptSignature,
    claudeSignature,
    systemText,
    anthropicImageToResponses,
    anthropicDocumentToResponses,
    responsesImageToAnthropic,
    responsesFileToAnthropic,
    normalizeSchema,
    anthropicReasoningEffort,
    isReasoningModel,
    reasoningEffortToAnthropic,
    anthropicToolResultOutput,
    responsesToolOutputContent,
    anthropicUsageToResponses,
    responsesUsageToAnthropic,
    responsesStopReason,
    responseStatus,
    claudeMessageId,
    responsesId,
    responseReasoningSummary
} from "./anthropic_responses_shared";

export function anthropicRequestToResponses(body: JsonObject): JsonObject {
    if (array(body.stop_sequences).length > 0) {
        throw new ProtocolConversionError(
            "OpenAI Responses API does not support Anthropic stop_sequences",
            400,
            "stop_sequences",
        );
    }

    const input: JsonObject[] = [];
    for (const [messageIndex, rawMessage] of array(body.messages).entries()) {
        const message = object(rawMessage);
        const role = string(message?.role);
        if (!message || (role !== "user" && role !== "assistant")) continue;
        const rawContent = typeof message.content === "string"
            ? [{ type: "text", text: message.content }]
            : array(message.content);
        let parts: JsonObject[] = [];
        const flushParts = () => {
            if (parts.length === 0) return;
            input.push({ type: "message", role, content: parts });
            parts = [];
        };

        for (const [blockIndex, rawBlock] of rawContent.entries()) {
            const block = object(rawBlock);
            if (!block) continue;
            switch (block.type) {
                case "text":
                    parts.push({
                        type: role === "assistant" ? "output_text" : "input_text",
                        text: string(block.text) ?? "",
                    });
                    break;
                case "image": {
                    const image = anthropicImageToResponses(block);
                    if (image) parts.push(image);
                    break;
                }
                case "document": {
                    const file = anthropicDocumentToResponses(block);
                    if (file) parts.push(file);
                    break;
                }
                case "thinking": {
                    const signature = role === "assistant" ? gptSignature(block.signature) : undefined;
                    if (!signature) break;
                    flushParts();
                    input.push({
                        type: "reasoning",
                        encrypted_content: signature,
                        summary: [{ type: "summary_text", text: string(block.thinking) ?? "" }],
                    });
                    break;
                }
                case "tool_use": {
                    if (role !== "assistant") break;
                    flushParts();
                    const name = string(block.name) ?? "unknown";
                    const callId = string(block.id) ?? stableCallId(messageIndex, blockIndex, name);
                    input.push({
                        type: "function_call",
                        id: `fc_${callId}`,
                        call_id: callId,
                        name,
                        arguments: compactJson(block.input),
                    });
                    break;
                }
                case "tool_result": {
                    if (role !== "user") break;
                    flushParts();
                    const output = anthropicToolResultOutput(block.content);
                    input.push({
                        type: "function_call_output",
                        call_id: string(block.tool_use_id) ?? "",
                        output: block.is_error === true
                            ? `[tool_error] ${typeof output === "string" ? output : JSON.stringify(output)}`
                            : output,
                    });
                    break;
                }
            }
        }
        flushParts();
    }

    // bridge 模式下的 Responses 上游请求保持精简，不传 metadata/user 等非必要字段。
    const response: JsonObject = { model: body.model, input, stream: body.stream === true, store: false };
    const instructions = systemText(body.system);
    if (instructions) response.instructions = instructions;
    for (const field of ["temperature", "top_p", "service_tier"] as const) {
        if (body[field] !== undefined) response[field] = body[field];
    }
    const effort = anthropicReasoningEffort(body);
    if (effort) response.reasoning = { effort };
    else if (isReasoningModel(body.model)) response.reasoning = { effort: "medium" };

    const mappedToolNames = new Set<string>();
    const tools = array(body.tools).flatMap((rawTool): JsonObject[] => {
        const tool = object(rawTool);
        const name = string(tool?.name);
        const type = string(tool?.type);
        if (!tool || !name || (type && type !== "custom" && type !== "function")) return [];
        mappedToolNames.add(name);
        return [{
            type: "function",
            name,
            ...(string(tool.description) ? { description: tool.description } : {}),
            parameters: normalizeSchema(tool.input_schema) ?? { type: "object", properties: {} },
        }];
    });
    if (tools.length > 0) response.tools = tools;

    const toolChoice = object(body.tool_choice);
    if (toolChoice) {
        if (toolChoice.type === "auto") response.tool_choice = "auto";
        if (toolChoice.type === "any") response.tool_choice = "required";
        if (toolChoice.type === "tool") {
            const name = string(toolChoice.name) ?? "";
            if (!mappedToolNames.has(name)) {
                throw new ProtocolConversionError(`Unsupported or missing forced tool: ${name}`, 400, "tool_choice");
            }
            response.tool_choice = { type: "function", name };
        }
        if (toolChoice.disable_parallel_tool_use === true) response.parallel_tool_calls = false;
    }

    return response;
}

function appendAnthropicMessage(messages: JsonObject[], role: "user" | "assistant", content: JsonObject[]) {
    if (content.length === 0) return;
    const previous = messages.at(-1);
    if (previous?.role === role && Array.isArray(previous.content)) {
        previous.content.push(...content);
        return;
    }
    messages.push({ role, content });
}

/** OpenAI Responses 请求直转 Anthropic Messages 请求。 */
export function responsesRequestToAnthropic(body: JsonObject): JsonObject {
    const messages: JsonObject[] = [];
    const systems: string[] = [];
    if (string(body.instructions)) systems.push(body.instructions as string);

    const rawInput = typeof body.input === "string"
        ? [{ type: "message", role: "user", content: [{ type: "input_text", text: body.input }] }]
        : array(body.input);
    for (const rawItem of rawInput) {
        const item = object(rawItem);
        if (!item) continue;
        const type = string(item.type) ?? (string(item.role) ? "message" : "");
        if (type === "message") {
            const role = string(item.role);
            const rawContent = typeof item.content === "string"
                ? [{ type: role === "assistant" ? "output_text" : "input_text", text: item.content }]
                : array(item.content);
            if (role === "system" || role === "developer") {
                const text = rawContent
                    .map(object)
                    .filter((part): part is JsonObject => part !== null)
                    .map((part) => string(part.text) ?? "")
                    .filter(Boolean)
                    .join("\n");
                if (text) systems.push(text);
                continue;
            }
            if (role !== "user" && role !== "assistant") continue;
            const content = rawContent.flatMap((rawPart): JsonObject[] => {
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
            appendAnthropicMessage(messages, role, content);
            continue;
        }
        if (type === "function_call") {
            const callId = string(item.call_id) ?? string(item.id)?.replace(/^fc_/, "") ?? "";
            appendAnthropicMessage(messages, "assistant", [{
                type: "tool_use",
                id: callId,
                name: string(item.name) ?? "unknown",
                input: parseObjectJson(item.arguments),
            }]);
            continue;
        }
        if (type === "function_call_output") {
            appendAnthropicMessage(messages, "user", [{
                type: "tool_result",
                tool_use_id: string(item.call_id) ?? "",
                content: responsesToolOutputContent(item.output),
            }]);
            continue;
        }
        if (type === "reasoning") {
            const signature = claudeSignature(item.encrypted_content);
            if (!signature) continue;
            const thinking = array(item.summary)
                .map(object)
                .filter((part): part is JsonObject => part !== null)
                .map((part) => string(part.text) ?? "")
                .join("");
            appendAnthropicMessage(messages, "assistant", [{ type: "thinking", thinking, signature }]);
        }
    }

    const response: JsonObject = {
        model: body.model,
        messages,
        stream: body.stream === true,
        max_tokens: integer(body.max_output_tokens) ?? 4096,
    };
    if (systems.length > 0) response.system = systems.join("\n");
    for (const field of ["temperature", "top_p", "service_tier"] as const) {
        if (body[field] !== undefined) response[field] = body[field];
    }
    Object.assign(response, reasoningEffortToAnthropic(body.reasoning));

    const mappedToolNames = new Set<string>();
    const tools = array(body.tools).flatMap((rawTool): JsonObject[] => {
        const tool = object(rawTool);
        if (!tool || tool.type !== "function" || !string(tool.name)) return [];
        mappedToolNames.add(tool.name as string);
        return [{
            name: tool.name,
            ...(string(tool.description) ? { description: tool.description } : {}),
            input_schema: normalizeSchema(tool.parameters) ?? { type: "object", properties: {} },
        }];
    });
    if (tools.length > 0) response.tools = tools;
    if (body.tool_choice === "auto") response.tool_choice = { type: "auto" };
    if (body.tool_choice === "required") response.tool_choice = { type: "any" };
    const toolChoice = object(body.tool_choice);
    if (toolChoice?.type === "function") {
        const name = string(toolChoice.name) ?? "";
        if (!mappedToolNames.has(name)) {
            throw new ProtocolConversionError(`Unsupported or missing forced tool: ${name}`, 400, "tool_choice");
        }
        response.tool_choice = { type: "tool", name };
    } else if (toolChoice && toolChoice.type !== "auto" && toolChoice.type !== "required") {
        throw new ProtocolConversionError(
            `Unsupported Responses tool choice: ${string(toolChoice.type) ?? "unknown"}`,
            400,
            "tool_choice",
        );
    }
    if (body.parallel_tool_calls === false && object(response.tool_choice)) {
        (response.tool_choice as JsonObject).disable_parallel_tool_use = true;
    }
    const metadata = object(body.metadata);
    if (metadata || string(body.user)) {
        response.metadata = { ...(metadata ?? {}), ...(string(body.user) ? { user_id: body.user } : {}) };
    }
    return response;
}


export function responsesResponseToAnthropic(response: JsonObject, request: JsonObject = {}): JsonObject {
    const content: JsonObject[] = [];
    let hasTool = false;
    for (const rawItem of array(response.output)) {
        const item = object(rawItem);
        if (!item) continue;
        if (item.type === "message") {
            for (const rawPart of array(item.content)) {
                const part = object(rawPart);
                if (part?.type === "output_text") {
                    content.push({ type: "text", text: string(part.text) ?? "" });
                }
            }
            continue;
        }
        if (item.type === "function_call") {
            hasTool = true;
            content.push({
                type: "tool_use",
                id: string(item.call_id) ?? string(item.id)?.replace(/^fc_/, "") ?? "toolu_unknown",
                name: string(item.name) ?? "unknown",
                input: parseObjectJson(item.arguments),
            });
            continue;
        }
        if (item.type === "reasoning") {
            const signature = claudeSignature(item.encrypted_content);
            if (signature) {
                content.push({
                    type: "thinking",
                    thinking: responseReasoningSummary(item),
                    signature,
                });
            } else if (item.encrypted_content !== undefined) {
                content.push({ type: "redacted_thinking", data: "" });
            }
        }
    }
    return {
        id: claudeMessageId(response.id),
        type: "message",
        role: "assistant",
        model: string(response.model) ?? string(request.model) ?? "unknown",
        content,
        stop_reason: responsesStopReason(response, hasTool),
        stop_sequence: null,
        usage: responsesUsageToAnthropic(response.usage),
    };
}

/** Anthropic Messages 普通响应转换为 OpenAI Responses 响应。 */
export function anthropicResponseToResponses(response: JsonObject, request: JsonObject = {}): JsonObject {
    const id = responsesId(response.id);
    const output: JsonObject[] = [];
    for (const [index, rawBlock] of array(response.content).entries()) {
        const block = object(rawBlock);
        if (!block) continue;
        if (block.type === "text") {
            output.push({
                id: `msg_${id}_${index}`,
                type: "message",
                status: "completed",
                role: "assistant",
                content: [{ type: "output_text", text: string(block.text) ?? "", annotations: [] }],
            });
            continue;
        }
        if (block.type === "tool_use") {
            const callId = string(block.id) ?? stableCallId(0, index, string(block.name) ?? "unknown");
            output.push({
                id: `fc_${callId}`,
                type: "function_call",
                status: "completed",
                call_id: callId,
                name: string(block.name) ?? "unknown",
                arguments: compactJson(block.input),
            });
            continue;
        }
        if (block.type === "thinking") {
            const signature = gptSignature(block.signature);
            if (!signature) continue;
            output.push({
                id: `rs_${id}_${index}`,
                type: "reasoning",
                status: "completed",
                encrypted_content: signature,
                summary: [{ type: "summary_text", text: string(block.thinking) ?? "" }],
            });
        }
    }
    return {
        id,
        object: "response",
        created_at: Math.floor(Date.now() / 1000),
        model: string(response.model) ?? string(request.model) ?? "unknown",
        ...responseStatus(response.stop_reason),
        output,
        usage: anthropicUsageToResponses(response.usage),
    };
}
