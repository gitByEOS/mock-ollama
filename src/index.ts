#!/usr/bin/env node
import { main } from "./cli";

export { app, createApp, dispatchMatrix } from "./router";
export {
    configureProvider,
    createProviderContext,
    detectUpstreamFormat,
    parseApiStyle,
    processApiPath,
    resolveUpstreamFormat,
    type ApiStyle,
    type ProviderContext,
} from "./provider";
export { matrixAction, type ApiFormat, type MatrixAction } from "./bridge/matrix";
export { createCursorApp, type CursorModel, type CursorProxyOptions } from "./cursor";
export { startCursorServer, type CursorServerOptions, type CursorTunnelMode } from "./cursor_server";
export { parseQuickTunnelUrl, startQuickTunnel } from "./cursor_tunnel";
export { main };

if (require.main === module) {
    main().catch((error) => {
        console.error("服务启动报错:", error);
        process.exit(1);
    });
}
