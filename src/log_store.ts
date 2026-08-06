import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

export type LogEntry = {
    id: number;
    time: string;
    method: string;
    path: string;
    sessionId?: string;
    cacheScope?: string;
    model?: string;
    duration?: number;
    status?: number;
    error?: string;
    request?: unknown;
    response?: unknown;
    cacheDrop?: {
        lostTokens: number;
        prevCacheRead: number;
        currentCacheRead: number;
    };
};

export const sseClients = new Set<{ write: (data: string) => void }>();
const logEntries: LogEntry[] = [];
let logIdCounter = 0;
const CACHE_DROPS_PATH = process.env.MOCK_OLLAMA_CACHE_DROPS_PATH;

function asRecord(value: unknown): Record<string, unknown> | undefined {
    return typeof value === "object" && value !== null ? value as Record<string, unknown> : undefined;
}

function getText(content: unknown): string {
    if (typeof content === "string") return content;
    if (Array.isArray(content)) {
        return content.map((item) => {
            const text = asRecord(item)?.text;
            return typeof text === "string" ? text : "";
        }).join("");
    }
    return JSON.stringify(content) ?? "";
}

export function extractCacheRead(response: unknown): number | undefined {
    const usage = asRecord(asRecord(response)?.usage);
    const candidates = [
        usage?.cache_read_input_tokens,
        asRecord(usage?.input_tokens_details)?.cached_tokens,
        asRecord(usage?.prompt_tokens_details)?.cached_tokens,
    ];
    return candidates.find((value): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0);
}

export function computeMessageDiff(prevRequest: unknown, currentRequest: unknown): Array<{ index: number; last: string | null; new: string | null }> {
    const prevMessages = asRecord(prevRequest)?.messages;
    const currentMessages = asRecord(currentRequest)?.messages;
    const prev = Array.isArray(prevMessages) ? prevMessages : [];
    const current = Array.isArray(currentMessages) ? currentMessages : [];
    const diffs: Array<{ index: number; last: string | null; new: string | null }> = [];

    for (let index = 0; index < Math.max(prev.length, current.length); index++) {
        const last = index < prev.length ? getText(asRecord(prev[index])?.content) : null;
        const next = index < current.length ? getText(asRecord(current[index])?.content) : null;
        if (last !== next) diffs.push({ index, last, new: next });
    }
    return diffs;
}

export async function appendCacheDropSample(sample: unknown): Promise<void> {
    if (!CACHE_DROPS_PATH) return;
    try {
        await mkdir(dirname(CACHE_DROPS_PATH), { recursive: true });
        await appendFile(CACHE_DROPS_PATH, `${JSON.stringify(sample)}\n`, "utf8");
    } catch (error) {
        console.error("append cache drop sample failed:", error);
    }
}

export function broadcastToSseClients(event: string, data: unknown) {
    const message = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const client of sseClients) {
        try {
            client.write(message);
        } catch {
            sseClients.delete(client);
        }
    }
}

export function addLogEntry(entry: Omit<LogEntry, "id">): LogEntry {
    const fullEntry: LogEntry = { ...entry, id: ++logIdCounter };
    if (fullEntry.method === "POST" && fullEntry.cacheScope && fullEntry.response) {
        const currentCacheRead = extractCacheRead(fullEntry.response);
        if (currentCacheRead !== undefined) {
            for (let index = logEntries.length - 1; index >= 0; index--) {
                const previous = logEntries[index];
                if (previous.method !== "POST" || previous.cacheScope !== fullEntry.cacheScope) continue;
                const prevCacheRead = extractCacheRead(previous.response);
                if (prevCacheRead === undefined) continue;
                if (currentCacheRead < prevCacheRead) {
                    const lostTokens = prevCacheRead - currentCacheRead;
                    const diffs = computeMessageDiff(previous.request, fullEntry.request);
                    const sample = {
                        time: fullEntry.time,
                        cacheScope: fullEntry.cacheScope,
                        logId: fullEntry.id,
                        prevLogId: previous.id,
                        model: fullEntry.model,
                        path: fullEntry.path,
                        lostTokens,
                        prevCacheRead,
                        currentCacheRead,
                        diffs,
                    };
                    void appendCacheDropSample(sample);
                    fullEntry.cacheDrop = { lostTokens, prevCacheRead, currentCacheRead };
                }
                break;
            }
        }
    }
    logEntries.push(fullEntry);
    if (logEntries.length > 200) logEntries.shift();
    broadcastToSseClients("new-log", fullEntry);
    return fullEntry;
}

export function getLogEntries(limit = 100): LogEntry[] {
    return logEntries.slice(-limit);
}

export function clearLogEntries() {
    logEntries.length = 0;
    logIdCounter = 0;
    broadcastToSseClients("clear-logs", { ok: true });
}
