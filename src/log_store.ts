export type LogEntry = {
    id: number;
    time: string;
    method: string;
    path: string;
    model?: string;
    duration?: number;
    status?: number;
    error?: string;
    request?: unknown;
    response?: unknown;
};

export const sseClients = new Set<{ write: (data: string) => void }>();
const logEntries: LogEntry[] = [];
let logIdCounter = 0;

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
    const fullEntry = { ...entry, id: ++logIdCounter };
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
