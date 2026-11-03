# 更新日志

本文件记录本插件的所有重要变更。

格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循[语义化版本](https://semver.org/lang/zh-CN/)。

## [未发布]

## [0.3.3] - 2026-11-03

### 修复

- **技能出现在目录里，但一加载就报错**：`ctx.skills.register({...})` 少了 `source` 字段，
  调用技能时报 `loaded skill "bilibili-video-summary" source must be a string`。
  原因是两道校验不一致——`register()` 里的 `validateRuntimeSkill` 只查
  `name`/`description`/`invocation`，所以注册能过、目录里看得见；真正加载正文时走
  `validateDefinition`，那里要求 `source`、`provider`、`content` 都是字符串。
  现在补上 `source: \`plugin:${name}\``。
  这类半坏状态最难查：功能列表里有，点进去才炸。

### 新增

- `scripts/check-entry.mjs` 增加第 6 条静态检查：出现 `skills.register({…})` 时，
  花括号配平取出该对象，缺 `source` 即失败。

## [0.3.2] - 2026-11-03

> `0.3.1` 曾经暂存到 npm 的 staging 区，但因为下面第二个错误没改透，**从未正式发布**
> （那条暂存记录已拒绝）。这里把版本号顺到 `0.3.2`，避免和它撞车。

### 修复

- **0.3.0 装上后 DSH 仍然启动失败**（第二层根因，比 0.3.0 的 `inject` 更隐蔽）：
  工具定义的 `output.schema` 里写了顶层 `required: ["ok"]` 数组，而 DSH 的
  value schema DSL **不接受**这种写法，加载时会抛
  `JsonSchemaError: unsupported JSON schema: schema.required is not supported
  by the value schema DSL`。因为这个插件在 profile 里是 `required: true`，
  一处 schema 不合规就升级成 `StartupError: 1 required plugin did not activate`，
  整个应用起不来。
  DSL 里正确的做法是**输出 schema 完全不标必填**——两种写法互斥且都会被拒：

  ```js
  // 错 1：顶层 required 数组 → valueSchemaSpecToJsonSchema 抛
  //   schema.required is not supported by the value schema DSL
  schema: { type: "object", required: ["ok"], properties: { ok: { type: "boolean" } } }

  // 错 2：属性级 required: true → tools.register 的 assertSupportedJsonSchema 抛
  //   schema.properties.ok.required is not supported on type "boolean"
  schema: { type: "object", properties: { ok: { type: "boolean", required: true } } }

  // 对：输出 schema 里不出现 required
  schema: { type: "object", additionalProperties: false, properties: { ok: { type: "boolean" } } }
  ```

  注意这条限制**只针对 `output.schema`**；`parameters` 里的属性级 `required: true`
  是合法且必要的写法，两者不要混为一谈。

### 新增

- `scripts/check-entry.mjs` 增加第 5 条静态检查：`lib/*.js` 里出现
  `required: [...]` 数组写法即失败，提示改成属性级 `required: true`。
  这条与 0.3.0 的 `inject` 检查合起来，覆盖「装上后让宿主起不来」的两类缺陷。

### 修复（工具返回值）

- `video_material` 的返回值改为先过 `compact()` 去掉值为 `undefined` 的键。
  DSH 在工具返回后会做一次严格 JSON 快照再按 `output.schema` 校验，
  而 `additionalProperties: false` 的封闭对象不该出现「有键无值」的属性。

## [0.3.0] - 2026-11-03

### 修复

- **装上本插件会让 DSH 起不来**（严重，影响所有 0.2.0 用户）：
  `apply(ctx)` 里直接访问 `ctx.tools` 与 `ctx.skills`，却没有导出 `inject`。
  cordis 的上下文代理对未注入的服务属性会抛
  `cannot get property "tools" without inject`，而这个异常发生在**宿主启动阶段**，
  用户看到的现象就是「DSH 启动失败」，而不是「某个插件不工作」。
  现在入口导出：

  ```js
  export const inject = ["tools", "skills"];
  ```

### 新增

- `scripts/check-entry.mjs` 增加第 4 条静态检查：把 `apply` 里出现的所有
  `ctx.<服务>` 找出来，逐个要求出现在 `export const inject` 里，缺一个就失败。
  同时校验 `cordis.patch.yml` 的挂载名、`@deepseek-ai/*` 的 peerDependencies 对齐。
  这类「装上后让宿主起不来」的缺陷以后过不了 CI。

### 包含之前未发布的内容

- `0.2.1` 的文档修正：README 的转写说明改成三级回退
  （站方字幕 → 本机 faster-whisper → 自定义命令），
  删掉不存在的 `python -m faster_whisper_cli` 示例，依赖表补 `faster-whisper`（可选）；
  `.gitignore` 补 `__pycache__/`、`*.pyc`。

### 说明

- npm 上 `0.2.1` 与 `0.2.2` 都从未发布（当次发布因令牌失效失败），
  内容已全部并入本版，所以版本号会从 `0.2.0` 直接跳到 `0.3.0`。
- 已安装 0.2.0 的用户必须升级：旧版会让 DSH 启动失败，
  升级前可先把 profile `dsh.profile.bundles` 里的条目移除，让 DSH 先能启动。

## [0.2.1] - 2026-10-19

### 修复

- **README 的转写说明和实现对不上**：原文写「ASR 不内置，只能靠 `VIDEOSUM_ASR_CMD` 自己配」，
  但 0.2.0 起已经会自动探测本机 faster-whisper，照原文读会以为必须手动配置。
  改为三级回退的真实描述：站方字幕 → 本机 faster-whisper → 自定义命令。
- 删掉一个并不存在的模块示例 `python -m faster_whisper_cli`，换成插件自带脚本的真实参数。
- `外部依赖` 表补上可选的 faster-whisper 一行，并说明缺了它会退回到「只有画面」。

### 变更

- `.gitignore` 增加 `__pycache__/`、`*.pyc`：在仓库里跑过一次
  `lib/asr/faster_whisper_asr.py` 就会生成 `lib/asr/__pycache__/`，
  而 `files` 里包含 `lib`，不排除会被一起发布。

## [0.2.0] - 2026-10-19

### 新增

- **自动探测本机 faster-whisper 做转写**：不用再自己拼 `VIDEOSUM_ASR_CMD`。
  装了 `pip install faster-whisper` 就能直接跑，插件会同时找到解释器与模型缓存目录
  （`HF_HOME`），默认 `small` 模型、CPU、`int8`，复用已下载的模型不重复下载。
- 新增 `lib/asr/faster_whisper_asr.py`：零依赖的调用脚本，输出 `[起-止] 文本` 行，
  参数 `--audio --out --model --lang --beam-size`。

### 变更

- 转写引擎改为三级回退：站方字幕 → 本机 faster-whisper → `VIDEOSUM_ASR_CMD`。
  三者都没有时仍产出画面素材，只是缺少逐字内容。
- `doctor` 输出新增 `asr` 字段，直接显示命中的是哪一级，例如 `faster-whisper/python.EXE`。

## [0.1.0] - 2026-10-16

首次发布。

### 新增

- **`video_material` 工具**：两个动作。
  `action=probe` 只取元数据（标题、作者、时长），用来确认链接是不是用户想说的那个视频；
  `action=material` 下载视频并准备全部总结素材——转写稿 `transcript.txt` / `.srt`、
  关键帧 `frames/`、拼图 `sheets/`、`meta.json`。
- **`bilibili-video-summary` 技能**：固化总结方法论——结论先行、
  两遍法读画面（先用 `sheets/` 通读全片，再回读 `frames/` 单张核对型号/重量/价格等细节）、
  ASR 识别的人名与型号必须回画面核对、静止文档类视频以画面文字为准。
- **自动启用**：通过 `agent/pre-step` 钩子，只在「用户消息里除了链接没有别的要求」时
  注入技能说明。消息里带「总结」「字幕」「怎么样」等明确要求时不会重复注入。
- **零依赖素材流水线** `lib/video-material.mjs`：也可单独当命令行用，
  子命令 `probe`、`material`、`frames`、`transcribe`、`doctor`。

### 说明

- **yt-dlp 探测会真的执行 `--version`**：按 显式路径 → PATH → `python -m yt_dlp`
  （自动尝试若干 `PYTHONPATH` 候选目录）的顺序验证，只有真能跑起来才算找到。
  这样 `doctor` 不会再把"文件存在但 import 不了"报成正常。
- **B 站走直连**：yt-dlp 会继承系统代理，而代理往往连不上 B 站 CDN，
  表现为 `HTTP Error 567`。插件对 `bilibili.com`、`bilivideo.com`、`hdslb.com`、`b23.tv`
  设置 `NO_PROXY` 直连，其他站点仍然走代理。
- **cookie 文件不会被改写**：yt-dlp 退出时会回写 cookie jar，
  因此插件先把 cookie 复制到插件数据目录再交给它，避免对只读位置写入失败。
- **索引文件表头用 ASCII**：`frames_index.txt`、`sheets_index.txt` 的表头是英文，
  避免不同编码下变成乱码影响模型读时间点。
- CI：`.github/workflows/check.yml` 在 Node 22 / 24 上跑语法检查、
  清单元数据检查、入口检查，并确认打包内容不含 cookie 等敏感文件。
