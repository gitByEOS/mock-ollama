import { spawn, type ChildProcessByStdio } from "node:child_process";
import type { Readable } from "node:stream";

export const QUICK_TUNNEL_URL = /https:\/\/([a-z0-9-]+\.trycloudflare\.com)/i;

export function parseQuickTunnelUrl(text: string): string | null {
    const match = QUICK_TUNNEL_URL.exec(text);
    return match ? `https://${match[1].toLowerCase()}` : null;
}

export type QuickTunnel = Readonly<{
    child: ChildProcessByStdio<null, Readable, Readable>;
    url: Promise<string>;
    stop: () => void;
}>;

/** 启动临时 Cloudflare Tunnel，并从日志中取得公开 HTTPS 地址。 */
export function startQuickTunnel(port: number): QuickTunnel {
    const child = spawn("cloudflared", ["tunnel", "--no-autoupdate", "--url", `http://127.0.0.1:${port}`], {
        stdio: ["ignore", "pipe", "pipe"],
    });

    let settled = false;
    let resolveUrl: (url: string) => void = () => undefined;
    let rejectUrl: (error: Error) => void = () => undefined;
    const url = new Promise<string>((resolve, reject) => {
        resolveUrl = resolve;
        rejectUrl = reject;
    });
    const timeout = setTimeout(() => {
        if (!settled) {
            settled = true;
            rejectUrl(new Error("Timed out waiting for Cloudflare quick tunnel URL"));
        }
    }, 45_000);
    timeout.unref();

    let output = "";
    const inspect = (chunk: Buffer) => {
        output = `${output}${chunk.toString()}`.slice(-8_192);
        const found = parseQuickTunnelUrl(output);
        if (found && !settled) {
            settled = true;
            clearTimeout(timeout);
            resolveUrl(found);
        }
    };
    child.stdout.on("data", inspect);
    child.stderr.on("data", inspect);
    child.once("error", (error) => {
        if (!settled) {
            settled = true;
            clearTimeout(timeout);
            rejectUrl(new Error(`Unable to start cloudflared: ${error.message}`));
        }
    });
    child.once("exit", (code, signal) => {
        if (!settled) {
            settled = true;
            clearTimeout(timeout);
            rejectUrl(new Error(`cloudflared exited before creating a tunnel (code ${code ?? "none"}, signal ${signal ?? "none"})`));
        }
    });

    return {
        child,
        url,
        stop: () => {
            clearTimeout(timeout);
            if (!child.killed) child.kill("SIGTERM");
        },
    };
}
