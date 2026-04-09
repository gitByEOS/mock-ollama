import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const distPath = join(process.cwd(), "dist", "index.js");
const cliHeader = "#!/usr/bin/env node\n";

if (!existsSync(distPath)) {
    console.error(`错误: 未找到 ${distPath}，请先执行构建`);
    process.exit(1);
}

let content = readFileSync(distPath, "utf8");
if (!content.startsWith(cliHeader)) {
    content = `${cliHeader}${content}`;
    writeFileSync(distPath, content, "utf8");
}

chmodSync(distPath, 0o755);
console.log(`已生成可执行 CLI: ${distPath}`);
