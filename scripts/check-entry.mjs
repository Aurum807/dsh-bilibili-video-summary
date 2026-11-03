#!/usr/bin/env node
// 静态检查插件入口。不需要安装依赖、不联网，所以在任何机器和 CI 上都能跑。
//
// 检查四件事，每一件对应一种"装上了却不工作"的真实故障：
//   1. 入口导出 name 与 apply(ctx) —— 宿主靠这两个加载插件
//   2. 代码里 import 的 @deepseek-ai/* 都写进了 peerDependencies
//      （漏声明 → 在别人机器上运行时报模块找不到）
//   3. cordis.patch.yml 里的挂载名与 package.json 的 name 一致
//      （不一致 → 安装成功但插件不生效，且很难查）
//   4. apply 里用到的 ctx 服务都在 export const inject 里声明了
//      （漏声明 → 宿主启动阶段直接抛 `cannot get property "x" without inject`，
//       插件整个加载失败，用户看到的是「DSH 起不来」）
//   5. 工具 schema 没有用 `required: [...]` 数组写法
//      （DSH 的 value schema DSL 只认属性级 `required: true`，数组写法会抛
//       `JsonSchemaError: unsupported JSON schema: schema.required is not supported
//       by the value schema DSL`，同样表现成「DSH 起不来」）

import { readFile } from "node:fs/promises";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const problems = [];
const notes = [];

const pkg = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));

// ---- 1. 入口导出 ----
const entryRel = pkg.main ?? "lib/index.js";
const entry = await readFile(path.join(root, entryRel), "utf8");

if (!/export\s+(?:async\s+)?function\s+apply\s*\(/.test(entry)) {
  problems.push(`${entryRel} 没有导出 apply 函数 —— 宿主加载插件时找不到它`);
}
if (!/export\s+const\s+name\s*=/.test(entry)) {
  problems.push(`${entryRel} 没有导出 name —— 插件在配置树里需要一个名字`);
}

// ---- 2. import 与 peerDependencies 对齐 ----
const declared = new Set(Object.keys(pkg.peerDependencies ?? {}));
const used = new Set();

const sourceFiles = (await import("node:fs")).readdirSync(path.join(root, "lib"))
  .filter((f) => f.endsWith(".js") || f.endsWith(".mjs"));

for (const file of sourceFiles) {
  const text = await readFile(path.join(root, "lib", file), "utf8");
  for (const m of text.matchAll(/from\s+["']([^"']+)["']/g)) {
    if (m[1].startsWith("@deepseek-ai/")) used.add(m[1]);
  }
}

for (const dep of used) {
  if (!declared.has(dep)) {
    problems.push(`lib/${sourceFiles.join("、lib/")} 里 import 了 ${dep}，但它没写进 peerDependencies`);
  }
}
for (const dep of declared) {
  if (!used.has(dep)) {
    notes.push(`peerDependencies 里的 ${dep} 在代码中没有被 import（用于向插件目录声明兼容范围时可保留）`);
  }
}

// ---- 3. patch 挂载名 ----
const patchRel = pkg.dsh?.bundle?.patch;
if (patchRel) {
  const patch = await readFile(path.join(root, patchRel), "utf8");
  if (!patch.includes(pkg.name)) {
    problems.push(`${patchRel} 里没有出现包名 "${pkg.name}" —— 装上后插件可能不生效`);
  }
}

// ---- 4. ctx 服务必须写进 inject ----
// cordis 访问未注入的服务属性会抛错，错误发生在启动阶段，整个插件加载失败。
// 这里把 `ctx.xxx` 里的 xxx 全找出来，去掉 cordis 自带的基础成员，其余都要求出现在 inject。
const CORDIS_BASE_MEMBERS = new Set([
  "on", "off", "once", "emit", "parallel", "serial", "bail",
  "plugin", "inject", "effect", "dispose", "logger",
  "get", "set", "provide", "accessor", "extend", "isolate",
  "scope", "root", "fiber", "registry", "reflect", "lifecycle"
]);

const injectMatch = /export\s+const\s+inject\s*=\s*\[([^\]]*)\]/.exec(entry);
const injected = new Set(
  (injectMatch?.[1] ?? "")
    .split(",")
    .map((s) => s.trim().replace(/^["']|["']$/g, ""))
    .filter(Boolean)
);

const accessed = new Set();
for (const m of entry.matchAll(/\bctx\.([A-Za-z_$][\w$]*)/g)) {
  if (!CORDIS_BASE_MEMBERS.has(m[1])) accessed.add(m[1]);
}

for (const svc of accessed) {
  if (!injected.has(svc)) {
    problems.push(
      `${entryRel} 里用到了 ctx.${svc}，但 export const inject 没声明它 ` +
      `—— 宿主启动时会抛 "cannot get property \\"${svc}\\" without inject"，插件加载失败`
    );
  }
}
if (accessed.size > 0 && !injectMatch) {
  notes.push("入口没有 export const inject，但用到了 ctx 服务：" + [...accessed].join("、"));
}

// ---- 5. output.schema 里不能出现 required ----
// 两种写法都会被宿主拒，且都表现成「装上后 DSH 起不来」：
//   顶层 required 数组 → valueSchemaSpecToJsonSchema 抛 schema.required is not supported
//   属性级 required: true → tools.register 的 assertSupportedJsonSchema 抛 not supported on type
// 注意：这条只约束 output.schema；parameters 里的 required: true 是合法写法。
const REQUIRED_ARRAY = /^\s*required\s*:\s*\[/;
for (const file of sourceFiles) {
  const text = await readFile(path.join(root, "lib", file), "utf8");
  const lines = text.split(/\r?\n/);

  lines.forEach((line, i) => {
    if (REQUIRED_ARRAY.test(line)) {
      problems.push(
        `lib/${file}:${i + 1} 用了 required 数组写法 ` +
        `—— 会抛 JsonSchemaError（schema.required is not supported by the value schema DSL），让宿主启动失败`
      );
    }
  });

  const outIdx = text.search(/\boutput\s*:\s*\{/);
  if (outIdx < 0) continue;

  const start = text.indexOf("{", outIdx);
  let depth = 0;
  let end = -1;
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) { end = i; break; }
    }
  }
  if (end <= start) continue;

  const firstLine = text.slice(0, start).split(/\r?\n/).length;
  text.slice(start, end + 1).split(/\r?\n/).forEach((line, i) => {
    const trimmed = line.trim();
    if (trimmed.startsWith("//")) return;
    if (/\brequired\b/.test(trimmed)) {
      problems.push(
        `lib/${file}:${firstLine + i} output 里出现了 required（${trimmed}）` +
        `—— 输出 schema 不能标必填：顶层数组会被 DSL 拒，属性级 true 会被注册期校验拒，` +
        `两种都会让宿主启动失败`
      );
    }
  });
}

for (const n of notes) console.log(`  提示：${n}`);

if (problems.length > 0) {
  console.error("入口检查失败：");
  for (const p of problems) console.error(`  ✗ ${p}`);
  process.exit(1);
}

console.log(`入口检查通过：${pkg.name}`);
console.log(`  入口文件   = ${entryRel}（已导出 name 与 apply）`);
console.log(`  使用的官方包 = ${[...used].sort().join("、") || "（无）"}`);
console.log(`  ctx 服务   = ${[...accessed].sort().join("、") || "（无）"} → inject = [${[...injected].sort().join("、")}]`);
console.log(`  patch 挂载名 = ${pkg.name}`);
