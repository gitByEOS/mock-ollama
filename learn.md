# node项目开发学习笔记
## 1. 项目初始化
- 创建项目文件夹
- 初始化项目 `npm init -y`
- 打开`package.json`文件，修改项目描述和作者信息，`type`改成`module`


## 2. 运行测试
新建index.ts文件

```bash
mkdir -p src
touch src/index.ts
```

```ts
// src/index.ts 写入以下代码

// 测试环境是否正常
console.log("=== 环境测试开始 ===");

// 测试 Node.js 版本
console.log(`Node.js 版本: ${process.version}`);
console.log(`当前工作目录: ${process.cwd()}`);

// 测试 TypeScript 类型
const testString: string = "TypeScript 类型检查正常";
console.log(testString);

console.log("=== 环境测试完成 ===");
```

```json
// package.json 修改
{
    "scripts": {
        "test": "tsx src/index.ts"
    }
}
```

再当前目录执行，输出正常即可
```bash
npm test
```

## 3. 最小测试模型
### 3.1 安装依赖
```bash
npm install hono @hono/node-server dotenv yargs
npm install -D typescript tsx @types/node @types/yargs
```

### 3.2 代码修改
```json
// package.json 修改
{
    "scripts": {
        "dev": "tsx watch src/index.ts"
    }
}
```

```ts
import { serve } from "@hono/node-server";
import { Hono } from "hono";

const app = new Hono();

app.get("/", (c) => c.text("ok"));

serve(
  {
    fetch: app.fetch,
    hostname: "localhost",
    port: 11434,
  },
  (info) => {
    console.log(`server running at http://${info.address}:${info.port}`);
  },
);
```

### 3.3 启动验证
```bash
npm run dev
curl http://localhost:11434/
```


## 4. 开启项目
### 4.1 生成tsconfig，引用项目配置
生成一分默认的tsconfig.json
```bash
npx tsc --init
```
最小可用
```json
{
  // Visit https://aka.ms/tsconfig to read more about this file
  "compilerOptions": {
    "module": "nodenext",
    "target": "esnext",
    "strict": true,
    "esModuleInterop": true,
    "allowSyntheticDefaultImports": true,
    "resolveJsonModule": true,
    "skipLibCheck": true,
    "types": ["node"],
    "rootDir": "src",
    "outDir": "dist"
  },
  "include": ["src/**/*.ts"]
}

```
``` ts
import { version, name } from "../package.json";
app.get("/api/version", (c) => c.json({ version: version, vendor: name }));
```
