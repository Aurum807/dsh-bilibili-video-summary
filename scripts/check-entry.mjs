#!/usr/bin/env node
// 静态检查插件入口。不需要安装依赖、不联网，所以在任何机器和 CI 上都能跑。
//
// 检查三件事，每一件对应一种"装上了却不工作"的真实故障：
//   1. 入口导出 name 与 apply(ctx) —— 宿主靠这两个加载插件
//   2. 代码里 import 的 @deepseek-ai/* 都写进了 peerDependencies
//      （漏声明 → 在别人机器上运行时报模块找不到）
//   3. cordis.patch.yml 里的挂载名与 package.json 的 name 一致
//      （不一致 → 安装成功但插件不生效，且很难查）

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

for (const n of notes) console.log(`  提示：${n}`);

if (problems.length > 0) {
  console.error("入口检查失败：");
  for (const p of problems) console.error(`  ✗ ${p}`);
  process.exit(1);
}

console.log(`入口检查通过：${pkg.name}`);
console.log(`  入口文件   = ${entryRel}（已导出 name 与 apply）`);
console.log(`  使用的官方包 = ${[...used].sort().join("、") || "（无）"}`);
console.log(`  patch 挂载名 = ${pkg.name}`);
