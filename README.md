# dsh-bilibili-video-summary

给 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH）用的插件：
**在对话里只发一条 B 站视频链接、不提任何要求时，自动开始总结这个视频。**

不是把链接丢给模型让它猜，而是先把视频变成可总结的素材——逐段时间轴转写稿 + 关键帧拼图——
再按一套固定的方法论产出总结。画面和文字互相校正，避免语音识别把人名、型号、数字说错。

## 装上之后是什么体验

> 你：`https://www.bilibili.com/video/BV1xx411c7mD/`
>
> 助手：（自动取素材、读拼图通读画面、回读关键帧核对参数）→ 直接给出一份结论先行的中文总结。

用户明确说了要干什么时（例如「总结这个」「讲了什么」「帮我翻译」），按用户的说法来，
插件不会抢着注入自己的流程。

## 它解决的问题

直接把视频链接给大模型，通常只能得到三种结果：复述标题、复述简介、或者编。原因是模型拿不到视频内容。
这个插件补上两样东西：

1. **转写稿**——优先用 UP 主自己上传的字幕；没有的话用语音识别，带时间轴，可回查原话。
2. **画面**——按固定间隔抽关键帧，再拼成 16 格「接触印相纸」。一份 20 分钟的视频，
   逐张读图要 190 次以上，读拼图只要 12 次左右，全片结构一眼看完，具体参数再回读单帧核对。

## 安装

需要先有 DSH。本插件按 DSH bundle 规范打包，装完即用：

```bash
# 从 npm 安装
dsh plugin --profile web add dsh-bilibili-video-summary

# 本地开发：直接指向本目录
dsh plugin --profile web add link:/绝对路径/dsh-bilibili-video-summary
```

装好后重启 DSH，插件会同时注册一个工具（`video_material`）和一个 skill（`bilibili-video-summary`）。

## 外部依赖

视频下载和转码依赖两个命令行工具，语音转写可选装一个 Python 包——**插件会自己找，找不到时会给出安装提示**：

| 依赖 | 用途 | 缺失影响 |
| --- | --- | --- |
| [yt-dlp](https://github.com/yt-dlp/yt-dlp) | 下载视频/音频、抓站方字幕 | 完全不可用 |
| [ffmpeg](https://ffmpeg.org/)（含 ffprobe） | 抽帧、分离音轨 | 只能拿转写稿，没有画面 |
| [faster-whisper](https://github.com/SYSTRAN/faster-whisper)（可选） | 没有站方字幕时做语音转写 | 退回到「只有画面素材」 |

转写引擎按三级回退自动找，**默认不需要你配置**：

1. **站方字幕** —— UP 主自己上传的字幕，最准也最快，有就直接用。
2. **本机 faster-whisper** —— 装了 `pip install faster-whisper` 就自动探测（连同模型缓存目录一起找），
   默认 `small` 模型、CPU、`int8`。20 分钟视频大约 2 分钟出稿。
3. **自定义命令** —— 设环境变量 `VIDEOSUM_ASR_CMD` 指向任何「音频 → 带时间戳文本」的命令，
   `{audio}` 替换成音频文件路径、`{out}` 替换成输出 txt 路径。适合已经装了别的引擎的人。
   插件自带一份调用脚本，可以照它的参数写：

   ```bash
   # 例：用自带脚本换更大的模型（参数：--audio --out --model --lang --beam-size）
   VIDEOSUM_ASR_CMD=python <插件目录>/lib/asr/faster_whisper_asr.py --audio {audio} --out {out} --model medium
   ```

三者都没有时，插件仍会产出全部画面素材，只是缺少逐字内容——总结照做，细节靠画面核对。
`node lib/video-material.mjs doctor` 会显示当前实际命中的是哪一级。

在 Windows 上，DSH 里跑的命令可能拿不到你交互式 shell 的 PATH。若插件报找不到工具，
用环境变量显式指定即可：

```bash
VIDEOSUM_YTDLP=D:\path\to\yt-dlp.exe
VIDEOSUM_FFMPEG=D:\path\to\ffmpeg.exe
VIDEOSUM_FFPROBE=D:\path\to\ffprobe.exe
```

### 只有 yt_dlp 模块、没有 yt-dlp 可执行文件

如果 yt-dlp 是作为一个 Python 包放在某个目录里（而不是装在解释器的 site-packages），
把它所在目录加进来，插件就会用 `python -m yt_dlp` 调用：

```bash
VIDEOSUM_PYLIBS=D:\path\to\dir-containing-yt_dlp
```

这一点特别值得留意：**文件存在不等于能用**。`yt_dlp` 目录躺在那里但不在
`PYTHONPATH` 里时，`import yt_dlp` 会报 `No module named yt_dlp`。所以插件对每个候选
都真的跑一次 `--version` 验证，`doctor` 报出来的版本号就是实测结果。

## 用法

大多数时候不用管——贴链接就行。也可以显式用它：

- **模型侧工具**：`video_material({ action: "probe", url })` 先看是不是目标视频；
  `video_material({ action: "material", url, every: 3 })` 准备全部素材。
- **命令行**（不经过模型，手动跑素材流水线）：

  ```bash
  node lib/video-material.mjs doctor              # 检查 yt-dlp / ffmpeg / 转写引擎是否就绪（会显示命中哪一级）
  node lib/video-material.mjs probe    --url <URL>
  node lib/video-material.mjs material --url <URL> --every 3
  ```

### 产物

默认输出到 `./vidsum_out/<视频标题>/`：

| 文件 | 内容 |
| --- | --- |
| `meta.json` | 标题、作者、时长、播放量、简介、章节 |
| `transcript.txt` | `[起-止] 文本` 逐段时间轴转写 |
| `transcript.srt` | 同名 SRT 字幕，可当字幕文件用 |
| `frames/f_*.jpg` | 关键帧单张（默认宽 640） |
| `frames_index.txt` | 单帧 ↔ 时间点对照 |
| `sheets/sheet_*.jpg` | 4×4 关键帧拼图 |
| `sheets_index.txt` | 拼图每格 ↔ 时间点对照 |

### 参数

| 参数 | 默认 | 说明 |
| --- | --- | --- |
| `--every` | 3 | 抽帧间隔秒。演示类调小（1～2），口播访谈调大（5～10） |
| `--width` | 640 | 关键帧宽度。读取耗时主要看像素数，640 宽约为 960 宽的一半，字幕仍可辨认 |
| `--max-frames` | 192 | 上限；视频过长时插件会自动放宽间隔以覆盖全片 |
| `--grid` / `--cell` | 4x4 / 384 | 拼图布局与每格宽度 |
| `--audio-only` | 关 | 只下音频，省流量 |
| `--no-sheets` / `--no-asr` | 关 | 跳过拼图 / 跳过转写 |

## 总结方法论

插件的 skill 里固化了这几条（也是它比「让模型自己看着办」稳定的原因）：

1. **先给一句话结论**，再展开。细节堆太多会把主线埋掉——用户看不懂通常不是因为信息不够。
2. **两遍法读画面**：先读拼图通读全片，再回读关键帧核对具体参数。
3. **语音识别结果不可全信**：型号、人名、数字一律回画面核对；核对不到就标存疑，不假装确定。
4. **静止文档类视频以画面文字为准**，实拍类视频以讲述为准、画面用来确认型号与数据。
5. **不添加视频里没有的信息**，争议内容标明是作者观点；对线类视频说明这是单方面说法。

## 常见故障

| 现象 | 原因 | 处理 |
| --- | --- | --- |
| `No module named yt_dlp` | yt-dlp 以 Python 模块形式存在，但不在 `PYTHONPATH` 里 | 设 `VIDEOSUM_PYLIBS` 指向含 `yt_dlp` 的目录 |
| `HTTP Error 412` | 没有 cookies，B 站拒绝 | 放好 `cookies/bilibili.txt` |
| `HTTP Error 567 Unknown Status` | 媒体下载走了**连不上 B 站 CDN 的本地代理** | 见下 |
| `PermissionError` 指向 cookie 文件 | cookie 文件在只读位置，yt-dlp 退出时回写失败 | 插件已自动复制到可写位置；若仍出现，把 cookie 放到可写目录 |

`567` 这个坑最值得说，因为它的报错完全看不出原因。yt-dlp 会读系统代理设置，
如果本机有个代理（例如 `127.0.0.1:7890`）而它连不通 B 站 CDN，每一个媒体分片
都会被判成 `567`；此时 `--simulate` 解析直链是**正常**的，只有真正传数据才失败，
所以很容易误判成限流或权限问题。

插件对 B 站域名自动追加 `NO_PROXY`（`bilibili.com`、`bilivideo.com`、`hdslb.com`、`b23.tv`），
其他站点仍走你原有的代理设置。如果你手动调 yt-dlp 也遇到，加 `--proxy ""` 即可。

## 已知限制

- B 站高画质与部分字幕需要登录。插件会自动读取工作区 `cookies/bilibili.txt`（Netscape 格式）
  或 `--cookies` 指定的文件。Cookie 会过期，过期后请重新导出。
- 转写质量取决于 ASR 引擎与音质；本插件不改善识别本身，只保证错误能被画面校正。
- 只对**用户消息里只有链接**的情况自动触发。如果同时贴了多条链接，只会总结第一条——
  想让插件逐条处理，直说即可。
- 抽帧是等间隔的，不是「智能选帧」。全屏 PPT 或长时间静止画面会有大量重复帧。
- 索引文件（`frames_index.txt`、`sheets_index.txt`）的表头是 **ASCII**，这是刻意的：
  按 GBK 解码中文会把表头变成乱码，而这些索引正是用来看时间点的。

## 开源协议

MIT，见 [LICENSE](LICENSE)。
