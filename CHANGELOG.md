# 更新日志

本文件记录本插件的所有重要变更。

格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循[语义化版本](https://semver.org/lang/zh-CN/)。

## [未发布]

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
