#!/usr/bin/env node
// 校验「插件能否被别人装上」所依赖的清单字段。
//
// 这些字段平时看不见，但缺一个就会有具体后果，所以放进 CI 防止改坏：
//   1. dsh.bundle.patch —— 没有它，`dsh plugin add` 装不上（最常见的被拒原因）
//   2. repository.url   —— 插件目录与 npm 靠它把包关联回仓库
//   3. engines.dsh      —— 目录侧的兼容性判定依据；缺了会退化成 unknown
//   4. 官方包放 peerDependencies —— 放 dependencies 会与宿主版本打架
//
// 零依赖，直接 node scripts/check-manifest.mjs 运行。

import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const problems = [];

const pkg = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));

// 1. dsh.bundle.patch
const patch = pkg.dsh?.bundle?.patch;
if (!patch) {
  problems.push(
    "缺少 dsh.bundle.patch —— 只声明 dsh.client 的插件无法被 dsh plugin add 安装",
  );
} else if (!existsSync(path.join(root, patch))) {
  problems.push(`dsh.bundle.patch 指向的文件不存在：${patch}`);
}

// 2. repository.url
if (!pkg.repository?.url) {
  problems.push("缺少 repository.url —— 插件目录无法把 npm 包关联回本仓库");
}

// 3. engines.dsh
if (!pkg.engines?.dsh) {
  problems.push("缺少 engines.dsh —— 目录侧兼容性判定会退化为 unknown");
}

// 4. 官方包必须是 peerDependencies
const wrongPlace = Object.keys(pkg.dependencies ?? {}).filter((n) =>
  n.startsWith("@deepseek-ai/"),
);
if (wrongPlace.length > 0) {
  problems.push(
    `官方 @deepseek-ai/* 包应声明为 peerDependencies，却出现在 dependencies：${wrongPlace.join(", ")}`,
  );
}

// 5. 插件入口必须存在
if (!pkg.main) {
  problems.push("缺少 main —— 宿主不知道加载哪个文件");
} else if (!existsSync(path.join(root, pkg.main))) {
  problems.push(`main 指向的文件不存在：${pkg.main}`);
}

if (problems.length > 0) {
  console.error("清单元数据检查失败：");
  for (const p of problems) console.error(`  ✗ ${p}`);
  process.exit(1);
}

console.log(`清单元数据检查通过：${pkg.name}@${pkg.version}`);
console.log(`  dsh.bundle.patch = ${patch}`);
console.log(`  engines.dsh      = ${pkg.engines.dsh}`);
console.log(`  engines.node     = ${pkg.engines.node}`);
console.log(`  repository       = ${pkg.repository.url}`);
console.log(`  main             = ${pkg.main}`);
