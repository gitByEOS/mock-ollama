// 测试环境是否正常
console.log("=== 环境测试开始 ===");

// 测试 Node.js 版本
console.log(`Node.js 版本: ${process.version}`);
console.log(`当前工作目录: ${process.cwd()}`);

// 测试 TypeScript 类型
const testString: string = "TypeScript 类型检查正常";
console.log(testString);

console.log("=== 环境测试完成 ===");