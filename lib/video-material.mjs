#!/usr/bin/env node
/**
 * video-material.mjs — 把视频地址变成「可总结的素材」：元数据 + 音轨 + 转写 + 关键帧接触印相纸。
 *
 * 设计目标（为什么自己写而不是直接调现成 CLI）：
 *  1. 0 运行时依赖：只用 Node 内置模块；ffmpeg / yt-dlp 走「发现 + 可配置」，找不到就给
 *     精确的安装提示，而不是抛一个 ENOENT。
 *  2. 两个调用者共用一套逻辑：插件里的工具（bilibili_video_summary）与人工/脚本命令行。
 *  3. 打印 JSON：调用者拿机器可读结果，人看 stderr 上的进度。
 *
 * 子命令：
 *   probe     只取元数据（不下载）
 *   material  一条龙：下载 -> 抽帧 -> 拼图 -> 转写（推荐）
 *   frames    只对已有视频抽帧 + 拼图
 *   transcribe 只对已有音轨转写（字幕优先，失败回落 ASR）
 *
 * 用法：
 *   node video-material.mjs probe      --url <URL> [--out DIR]
 *   node video-material.mjs material   --url <URL> [--out DIR] [--every 3] [--width 640]
 *                                      [--max-frames 192] [--grid 4x4] [--cell 384]
 *                                      [--audio-only] [--no-sheets] [--no-asr]
 *                                      [--cookies FILE]
 *   node video-material.mjs frames     --video FILE --out DIR [--every 3] [--width 640]
 *   node video-material.mjs transcribe --audio FILE --out DIR [--lang zh] [--cookies FILE] [--url URL]
 */

import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const VERSION = "0.2.0";

/** 工作区里存放插件自有数据的隐藏目录（下载的依赖、临时文件）。 */
const DATA_DIR_NAME = ".dsh-bilibili-video-summary";

// ---------------------------------------------------------------------------
// 工具发现
// ---------------------------------------------------------------------------

/** 把版本探测结果缓存住：一次运行里反复探测同一个可执行文件没有意义。 */
const probeCache = new Map();

/**
 * 在 PATH 上查找可执行文件（Windows 需要补 PATHEXT 的那些后缀）。
 * @param {string} bin 可执行文件名，例如 ffmpeg。
 * @returns {string|undefined} 绝对路径；找不到返回 undefined。
 */
function whichSync(bin) {
	if (probeCache.has(`which:${bin}`)) return probeCache.get(`which:${bin}`);
	const exts = process.platform === "win32"
		? (process.env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM").split(";").filter(Boolean)
		: [""];
	const dirs = (process.env.PATH ?? "").split(path.delimiter).filter(Boolean);
	let found;
	for (const dir of dirs) {
		for (const ext of exts) {
			const candidate = path.join(dir, bin + ext);
			try {
				const st = fs.statSync(candidate);
				if (st.isFile()) {
					found = candidate;
					break;
				}
			} catch {
				/* 继续找 */
			}
		}
		if (found) break;
	}
	probeCache.set(`which:${bin}`, found);
	return found;
}

/** 候选 Python 解释器：先看环境变量，再看 PATH 上的常见名字。 */
function pythonCandidates() {
	const out = [];
	if (process.env.VIDEOSUM_PYTHON) out.push(process.env.VIDEOSUM_PYTHON);
	for (const name of ["python", "python3", "py"]) {
		const hit = whichSync(name);
		if (hit) out.push(hit);
	}
	return out;
}

/**
 * 同步跑一个探针命令，只看成败。
 *
 * 刻意用文件描述符而不是管道：受限沙箱禁止创建命名管道，管道捕获会 EPERM。
 * @param {string} cmd 可执行文件。
 * @param {string[]} args 参数。
 * @param {string|undefined} pythonPath 需要时注入的 PYTHONPATH。
 * @returns {{ok: boolean, output: string}}
 */
function probeSync(cmd, args, pythonPath) {
	const dir = runScratchDir();
	const outFile = path.join(dir, `.videosum-probe-${process.pid}-${runSeq++}.log`);
	let fd;
	try {
		fd = fs.openSync(outFile, "w");
	} catch {
		return { ok: false, output: "" };
	}
	try {
		const result = spawnSync(cmd, args, {
			windowsHide: true,
			stdio: ["ignore", fd, fd],
			timeout: 60_000,
			env: { ...process.env, PYTHONIOENCODING: "utf-8", ...(pythonPath ? { PYTHONPATH: pythonPath } : {}) }
		});
		const output = readFileText(outFile);
		return { ok: result.status === 0, output };
	} catch (error) {
		return { ok: false, output: error instanceof Error ? error.message : String(error) };
	} finally {
		try {
			fs.closeSync(fd);
		} catch {
			/* 已关 */
		}
		cleanup([outFile]);
	}
}

/** 从探针输出里抓版本号，抓不到就返回空串。 */
function versionFrom(output) {
	return /\d{4}\.\d{2}\.\d{2}(?:\.\d+)?/.exec(output)?.[0]
		?? /\d+\.\d+\.\d+/.exec(output)?.[0]
		?? "";
}

/**
 * 解析 yt-dlp 的调用方式，并且**实际执行一次**确认可用。
 *
 * 只检查文件是否存在是不够的：`python -m yt_dlp` 在没有 PYTHONPATH 时会报
 * `No module named yt_dlp`，而文件看起来是存在的。所以这里逐个候选真的跑一遍。
 * @returns {Promise<{cmd: string[], kind: string, version?: string, env?: object, hint?: string}>}
 */
export async function resolveYtDlp() {
	if (probeCache.has("ytdlp")) return probeCache.get("ytdlp");

	const verify = (cmd, kind, pythonPath) => {
		const result = probeSync(cmd[0], [...cmd.slice(1), "--version"], pythonPath);
		if (!result.ok) return undefined;
		const version = versionFrom(result.output);
		return {
			cmd,
			kind,
			version: version === "" ? undefined : version,
			...(pythonPath ? { env: { PYTHONPATH: pythonPath } } : {})
		};
	};

	let found;
	// 1) 显式指定的可执行文件
	if (process.env.VIDEOSUM_YTDLP) {
		found = verify([process.env.VIDEOSUM_YTDLP], "env");
		if (found) found.hint = undefined;
	}
	// 2) PATH 上的 yt-dlp
	if (!found) {
		const onPath = whichSync("yt-dlp");
		if (onPath) found = verify([onPath], "path");
	}
	// 3) 作为 Python 模块：挨个候选目录试 PYTHONPATH
	if (!found) {
		const libs = [];
		if (process.env.VIDEOSUM_PYLIBS) libs.push(process.env.VIDEOSUM_PYLIBS);
		if (process.env.WORKSPACE_DIR) {
			libs.push(path.join(process.env.WORKSPACE_DIR, ".pylibs"));
			libs.push(path.join(process.env.WORKSPACE_DIR, DATA_DIR_NAME, "pylibs"));
		}
		libs.push(path.join(process.cwd(), ".pylibs"));
		libs.push(path.join(pluginDataDir(), "pylibs"));
		const seen = new Set();
		for (const lib of libs) {
			if (seen.has(lib)) continue;
			seen.add(lib);
			if (!fs.existsSync(path.join(lib, "yt_dlp", "__init__.py"))) continue;
			for (const py of pythonCandidates()) {
				const attempt = verify([py, "-m", "yt_dlp"], "python-module", lib);
				if (attempt) {
					found = { ...attempt, lib };
					break;
				}
			}
			if (found) break;
		}
		// 模块可能装在解释器自己的 site-packages 里，不需要 PYTHONPATH
		if (!found) {
			for (const py of pythonCandidates()) {
				const attempt = verify([py, "-m", "yt_dlp"], "python-module");
				if (attempt) {
					found = attempt;
					break;
				}
			}
		}
	}
	if (!found) {
		found = {
			cmd: [],
			kind: "missing",
			hint: [
				"未找到可用的 yt-dlp（存在但 import 不了也算不可用）。安装任选其一：",
				"  pip install -U yt-dlp",
				"  或把 yt_dlp 包放到 <工作区>/.pylibs/ 下",
				"  或用 VIDEOSUM_YTDLP 指向 yt-dlp 可执行文件"
			].join("\n")
		};
	}
	probeCache.set("ytdlp", found);
	return found;
}

/**
 * 解析 ffmpeg / ffprobe 的可执行路径。
 * @param {"ffmpeg"|"ffprobe"} bin 工具名。
 * @returns {{cmd: string, hint?: string}} 命令路径或安装提示。
 */
export function resolveFfmpeg(bin) {
	const key = `ff:${bin}`;
	if (probeCache.has(key)) return probeCache.get(key);
	const result = (() => {
		const envKey = bin === "ffmpeg" ? "VIDEOSUM_FFMPEG" : "VIDEOSUM_FFPROBE";
		const explicit = process.env[envKey];
		if (explicit) return { cmd: explicit };
		const onPath = whichSync(bin);
		if (onPath) return { cmd: onPath };
		if (process.env.FFMPEG_DIR) {
			const candidate = path.join(process.env.FFMPEG_DIR, bin + (process.platform === "win32" ? ".exe" : ""));
			if (fs.existsSync(candidate)) return { cmd: candidate };
		}
		return { cmd: "", hint: `未找到 ${bin}。安装 ffmpeg 并确保它在 PATH 上，或用 ${envKey} 指定路径。` };
	})();
	probeCache.set(key, result);
	return result;
}

// ---------------------------------------------------------------------------
// 进程执行
// ---------------------------------------------------------------------------

/**
 * 子进程输出落地的临时文件前缀与序号。
 *
 * 为什么不用 `stdio: "pipe"`：受限沙箱禁止进程创建命名管道，Node 用管道捕获
 * 子进程输出会直接抛 `spawn EPERM`。改用文件描述符重定向——子进程直接写文件，
 * 不经过管道，任何模式下都可用；顺带还不受管道缓冲区限制。
 */
let runSeq = 0;

/** 找一个能放临时输出的目录：先试系统临时目录，再退回当前工作目录。 */
function runScratchDir() {
	const candidates = [os.tmpdir(), process.env.TEMP, process.cwd()];
	for (const dir of candidates) {
		if (typeof dir !== "string" || dir === "") continue;
		try {
			const probe = path.join(dir, `.videosum-write-test-${process.pid}`);
			fs.writeFileSync(probe, "");
			fs.rmSync(probe, { force: true });
			return dir;
		} catch {
			/* 试下一个 */
		}
	}
	return process.cwd();
}

/**
 * 插件自有数据目录（cookies 副本、下载的依赖等）。
 * 优先放在可写的工作区根下；没有工作区就退回系统临时目录。
 * @param {...string} parts 子路径。
 * @returns {string} 绝对路径。
 */
function pluginDataDir(...parts) {
	const root = process.env.WORKSPACE_DIR
		? path.join(process.env.WORKSPACE_DIR, DATA_DIR_NAME)
		: path.join(os.tmpdir(), DATA_DIR_NAME);
	return path.join(root, ...parts);
}

/**
 * 跑一个子进程并收集输出。
 *
 * 输出走文件描述符而非管道：受限沙箱禁止创建命名管道，管道捕获会 EPERM。
 * @param {string[]} argv 命令与参数。
 * @param {{cwd?: string, timeoutMs?: number, quiet?: boolean, label?: string, env?: object}} [opts]
 * @returns {Promise<{code: number|null, stdout: string, stderr: string, timedOut: boolean}>}
 */
export function run(argv, opts = {}) {
	const { cwd, timeoutMs, quiet = false, label, env } = opts;
	const dir = runScratchDir();
	const stamp = `${process.pid}-${runSeq++}`;
	const outFile = path.join(dir, `.videosum-out-${stamp}.log`);
	const errFile = path.join(dir, `.videosum-err-${stamp}.log`);

	return new Promise((resolve) => {
		let outFd;
		let errFd;
		try {
			outFd = fs.openSync(outFile, "w");
			errFd = fs.openSync(errFile, "w");
		} catch (error) {
			// 连文件都开不了：退化成继承父进程的 stderr，至少让用户看到子进程在说什么。
			resolve({ code: null, stdout: "", stderr: `无法创建子进程输出文件: ${error.message}`, timedOut: false });
			return;
		}

		let child;
		try {
			child = spawn(argv[0], argv.slice(1), {
				cwd,
				windowsHide: true,
				stdio: ["ignore", outFd, errFd],
				env: { ...process.env, PYTHONIOENCODING: "utf-8", ...(env ?? {}) }
			});
		} catch (error) {
			fs.closeSync(outFd);
			fs.closeSync(errFd);
			cleanup([outFile, errFile]);
			resolve({ code: null, stdout: "", stderr: error.message, timedOut: false });
			return;
		}
		fs.closeSync(outFd);
		fs.closeSync(errFd);

		let timedOut = false;
		let timer;
		if (timeoutMs !== undefined && timeoutMs > 0) {
			timer = setTimeout(() => {
				timedOut = true;
				try {
					child.kill("SIGKILL");
				} catch {
					/* 已经退出 */
				}
			}, timeoutMs);
		}

		// 实时回显：让长任务（下载、转写）的进度可见，而不是结束后一次性吐出来。
		let shown = 0;
		let pump;
		if (!quiet) {
			pump = setInterval(() => {
				try {
					const size = fs.statSync(errFile).size;
					if (size <= shown) return;
					const fd = fs.openSync(errFile, "r");
					const buf = Buffer.alloc(size - shown);
					fs.readSync(fd, buf, 0, buf.length, shown);
					fs.closeSync(fd);
					shown = size;
					for (const line of buf.toString("utf8").split(/\r?\n/)) {
						if (line.trim() !== "") process.stderr.write(`  [${label ?? path.basename(argv[0])}] ${line.trim()}\n`);
					}
				} catch {
					/* 文件正在被写，下一轮再读 */
				}
			}, 700);
		}

		const finish = (code, extraError) => {
			if (timer) clearTimeout(timer);
			if (pump) clearInterval(pump);
			const stdout = readFileText(outFile);
			const stderr = readFileText(errFile) + (extraError === undefined ? "" : `\n${extraError}`);
			cleanup([outFile, errFile]);
			resolve({ code, stdout, stderr, timedOut });
		};

		child.on("error", (error) => finish(null, error.message));
		child.on("close", (code) => finish(code));
	});
}

/** 读文本文件；读不到就返回空串。 */
function readFileText(file) {
	try {
		return fs.readFileSync(file, "utf8");
	} catch {
		return "";
	}
}

/** 删除一批文件，忽略失败。 */
function cleanup(files) {
	for (const file of files) {
		try {
			fs.rmSync(file, { force: true });
		} catch {
			/* 无所谓 */
		}
	}
}

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

/**
 * 生成安全的目录名。
 * @param {string} text 原始标题。
 * @param {number} [limit] 最大长度。
 * @returns {string} 可用于文件系统的名字。
 */
export function slugify(text, limit = 60) {
	const cleaned = String(text ?? "")
		.replace(/[\\/:*?"<>|\r\n\t]+/g, "_")
		.replace(/\s+/g, " ")
		.trim()
		.replace(/^[ ._]+|[ ._]+$/g, "");
	return (cleaned.slice(0, limit) || "video").replace(/^[ ._]+|[ ._]+$/g, "");
}

/** 把秒数格式化成 mm:ss（超过一小时则 h:mm:ss）。 */
export function clock(seconds) {
	const total = Math.max(0, Math.round(seconds));
	const h = Math.floor(total / 3600);
	const m = Math.floor((total % 3600) / 60);
	const s = total % 60;
	const pad = (n) => String(n).padStart(2, "0");
	return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}

/** 把秒数格式化成 SRT 时间戳。 */
function srtStamp(seconds) {
	const total = Math.max(0, seconds);
	const h = Math.floor(total / 3600);
	const m = Math.floor((total % 3600) / 60);
	const s = Math.floor(total % 60);
	const ms = Math.round((total - Math.floor(total)) * 1000);
	const pad = (n, w = 2) => String(n).padStart(w, "0");
	return `${pad(h)}:${pad(m)}:${pad(s)},${pad(ms, 3)}`;
}

const MEDIA_EXT = {
	audio: [".m4a", ".mp3", ".opus", ".webm", ".aac", ".ogg", ".wav", ".flac"],
	video: [".mp4", ".mkv", ".webm", ".flv", ".mov"]
};

/** 按扩展名优先级挑出真正下载下来的媒体文件（忽略 .info.json / 缩略图）。 */
function pickMedia(dir, exts, stem) {
	for (const ext of exts) {
		const file = path.join(dir, stem + ext);
		try {
			if (fs.statSync(file).size > 0) return file;
		} catch {
			/* 试下一个 */
		}
	}
	return undefined;
}

/** 站点 -> 工作区 cookies 文件名，用于解锁登录后才能拿到的清晰度与字幕。 */
const COOKIE_SITES = [
	["bilibili.com", "bilibili.txt"],
	["b23.tv", "bilibili.txt"],
	["youtube.com", "youtube.txt"],
	["youtu.be", "youtube.txt"],
	["weibo.com", "weibo.txt"],
	["douyin.com", "douyin.txt"]
];

/**
 * 把 cookie 文件复制成一份**可写**的临时副本，返回副本路径。
 *
 * 为什么要复制：yt-dlp 退出时会回写 cookie jar（比如刷新 SESSDATA）。如果原文件
 * 位于只读位置（工作区里常见的 `cookies/` 就可能被沙箱设为只读），回写会抛
 * `PermissionError: [Errno 13]`，在自动抓字幕这条路径上会直接判失败。
 * 副本放在可写的临时目录里，回写就落到副本上。
 * 源文件的 mtime 变化时会重新复制，保证用户刚导入的 cookie 立刻生效。
 * @param {string} file 源 cookie 文件。
 * @returns {string} 可写副本的路径；无法复制时回退为原路径。
 */
function writableCookieFile(file) {
	const dir = pluginDataDir("cookies");
	try {
		// 同步 API 走 fs，不走 fsp（fs/promises 没有 *Sync 方法）。
		fs.mkdirSync(dir, { recursive: true });
		const copy = path.join(dir, path.basename(file));
		const src = fs.statSync(file);
		const fresh = fs.existsSync(copy) && fs.statSync(copy).mtimeMs >= src.mtimeMs;
		if (!fresh) fs.copyFileSync(file, copy);
		return copy;
	} catch {
		// 复制不了就退回原文件：大不了 yt-dlp 回写失败，不影响读 cookie。
		return file;
	}
}

/**
 * 解析 cookie 参数。
 *
 * 文件一定存在时才返回：显式指定的路径不存在就报错，但**自动发现的路径**
 * 只在确实存在时才用。否则 yt-dlp 会因 `--cookies <不存在的文件>` 直接失败，
 * 表现成“莫名其妙的下载失败”，反而更难排查。
 * @param {string} url 视频地址。
 * @param {string|undefined} explicit 显式指定的 cookies.txt。
 * @returns {string[]} 可直接展开的 yt-dlp 参数。
 */
export function cookieArgs(url, explicit) {
	if (explicit) {
		if (!fs.existsSync(explicit)) throw new Error(`指定的 cookie 文件不存在: ${explicit}`);
		return ["--cookies", writableCookieFile(explicit)];
	}
	const roots = [];
	if (process.env.VIDEOSUM_COOKIE_DIR) roots.push(process.env.VIDEOSUM_COOKIE_DIR);
	if (process.env.WORKSPACE_DIR) roots.push(path.join(process.env.WORKSPACE_DIR, "cookies"));
	// 直接跑 CLI 时没有 WORKSPACE_DIR，此时以当前目录为工作区根（和默认输出目录一致）。
	roots.push(path.join(process.cwd(), "cookies"));
	const low = String(url ?? "").toLowerCase();
	for (const [host, file] of COOKIE_SITES) {
		if (!low.includes(host)) continue;
		for (const root of roots) {
			const candidate = path.join(root, file);
			if (fs.existsSync(candidate)) return ["--cookies", writableCookieFile(candidate)];
		}
	}
	return [];
}

// ---------------------------------------------------------------------------
// yt-dlp 包装
// ---------------------------------------------------------------------------

/**
 * 媒体传输阶段的固定参数。这几条都是实测出来的，不是随手加的：
 *
 *  - `--no-part`：B 站 CDN 对 `.part` 分段写入不友好，直写目标文件更稳。
 *  - `--referer`：缺失时容易被拒。
 *  - `--sleep-requests` / `--retry-sleep`：默认重试是立刻重发 10 次，等于在
 *    触发风控后继续猛敲；放慢之后成功率明显变好。
 */
const MEDIA_TRANSFER_ARGS = [
	"--referer", "https://www.bilibili.com/",
	"--no-part",
	"--sleep-requests", "1",
	"--retry-sleep", "5",
	"--retries", "5"
];

/** 这些域名不该走代理：本地代理不可用时，走代理会让媒体下载直接失败。 */
const DIRECT_HOSTS = ["bilibili.com", "bilivideo.com", "hdslb.com", "b23.tv"];

/**
 * 让 B 站相关域名绕过代理。
 *
 * yt-dlp 会读系统/环境里的代理设置。实测中本机存在一个 `127.0.0.1:7890` 代理，
 * 它连不上 B 站 CDN，于是每个媒体分片都被判成 `HTTP 567 Unknown Status` —— 报错
 * 完全看不出是代理问题，而且只用 `--no-part` 之类的手段治不好。直连后立刻正常。
 *
 * 只对 B 站域名绕过，其他站点仍按用户原有设置走代理（例如 YouTube 可能需要代理）。
 * @param {string} url 目标地址。
 * @returns {{NO_PROXY: string}|undefined} 可直接展开进 env 的对象。
 */
function proxyEnv(url) {
	const low = String(url ?? "").toLowerCase();
	if (!DIRECT_HOSTS.some((host) => low.includes(host))) return undefined;
	const existing = process.env.NO_PROXY ?? process.env.no_proxy ?? "";
	const parts = existing.split(",").map((s) => s.trim()).filter(Boolean);
	if (!parts.includes("*")) {
		for (const host of DIRECT_HOSTS) {
			if (!parts.includes(host)) parts.push(host);
		}
	}
	return { NO_PROXY: parts.join(",") };
}

/**
 * 格式化选择串：小体积高画质编码优先，避免动辄几百 MB 的 H.264。
 * @param {number} maxHeight 最大高度；0 表示不限制。
 */
function videoFormat(maxHeight) {
	const h = maxHeight > 0 ? maxHeight : 9999;
	return [
		`bv*[height<=${h}][vcodec^=av01]+ba`,
		`bv*[height<=${h}][vcodec^=hev1]+ba`,
		`bv*[height<=${h}]+ba`,
		"bv*[height<=720]+ba",
		"bv*+ba",
		"b"
	].join("/");
}

/**
 * 用 yt-dlp 打印单个字段，用来快速拿标题（不下载）。
 * @returns {Promise<string>} 标题；失败返回空串。
 */
async function probeTitle(url, cookies) {
	const yt = await resolveYtDlp();
	if (yt.kind === "missing") return "";
	const res = await run([...yt.cmd, "--no-warnings", "--skip-download", "--no-playlist",
		"--print", "%(title)s", ...cookieArgs(url, cookies), url],
		{ timeoutMs: 120_000, env: { ...yt.env, ...proxyEnv(url) } });
	if (res.code !== 0) return "";
	const lines = res.stdout.trim().split(/\r?\n/).filter(Boolean);
	return lines.at(-1) ?? "";
}

/**
 * 下载媒体并返回元数据。
 * @param {{url: string, dest: string, audioOnly: boolean, quality: number, cookies?: string}} options
 */
async function downloadMedia({ url, dest, audioOnly, quality, cookies }) {
	const yt = await resolveYtDlp();
	if (yt.kind === "missing") throw new Error(yt.hint);
	await fsp.mkdir(dest, { recursive: true });
	const stem = audioOnly ? "audio" : "video";
	const cookieList = cookieArgs(url, cookies);
	const argv = [...yt.cmd, "--no-warnings", "--no-playlist", "--write-info-json",
		"-f", audioOnly ? "bestaudio" : videoFormat(quality),
		"-o", path.join(dest, `${stem}.%(ext)s`),
		...cookieList];
	if (!audioOnly) argv.push("--merge-output-format", "mp4");
	argv.push(...MEDIA_TRANSFER_ARGS);
	argv.push(url);
	process.stderr.write(`[1/3] 下载中…（${audioOnly ? "仅音频" : "含视频"}）\n`);
	const res = await run(argv, { timeoutMs: 30 * 60_000, label: "yt-dlp", env: { ...yt.env, ...proxyEnv(url) } });
	if (res.code !== 0) {
		const tail = (res.stderr || res.stdout).trim().split(/\r?\n/).slice(-8).join("\n");
		// B 站对未登录/异常客户端会回 412、567 这类反爬状态码。这个报错本身完全看不出
		// 原因，所以把两种最常见的解释直接写进错误信息里。
		const antiBot = /HTTP Error (412|5\d\d)|Precondition Failed|Unknown Status/i.test(tail);
		let hint = "";
		if (antiBot && cookieList.length === 0) {
			const cookieDir = process.env.VIDEOSUM_COOKIE_DIR
				?? (process.env.WORKSPACE_DIR ? path.join(process.env.WORKSPACE_DIR, "cookies") : "<工作区>\\cookies");
			hint = `\n\n提示：没有找到 cookies。把浏览器导出的 cookies.txt 放到 ${cookieDir}\\`
				+ "（或设置 VIDEOSUM_COOKIE_DIR），或用 --cookies <文件> 显式指定。";
		} else if (/Unknown Status|HTTP Error 567/i.test(tail)) {
			hint = "\n\n提示：这是 B 站 CDN 的限流（567）。已经有 cookies 的情况下再遇到，"
				+ "通常是短时间内请求太多，等几分钟再试即可。";
		}
		throw new Error(`下载失败（yt-dlp 退出码 ${res.code}）:\n${tail}${hint}`);
	}
	let info = {};
	const infoFile = path.join(dest, `${stem}.info.json`);
	if (fs.existsSync(infoFile)) {
		try {
			info = JSON.parse(await fsp.readFile(infoFile, "utf8"));
		} catch {
			info = {};
		}
	}
	return { info, media: pickMedia(dest, audioOnly ? MEDIA_EXT.audio : MEDIA_EXT.video, stem) };
}

/**
 * 从视频里分离音轨给转写用（合并下载时音轨在 mp4 里）。
 * @returns {Promise<string|undefined>} 音轨路径。
 */
async function extractAudio(video, dest) {
	const ff = resolveFfmpeg("ffmpeg");
	if (!ff.cmd) throw new Error(ff.hint);
	const out = path.join(dest, "audio.m4a");
	let res = await run([ff.cmd, "-hide_banner", "-loglevel", "error", "-y",
		"-i", video, "-vn", "-c:a", "copy", out], { timeoutMs: 10 * 60_000 });
	let ok = res.code === 0 && fs.existsSync(out) && fs.statSync(out).size > 0;
	if (!ok) {
		res = await run([ff.cmd, "-hide_banner", "-loglevel", "error", "-y",
			"-i", video, "-vn", "-c:a", "aac", "-b:a", "160k", out], { timeoutMs: 10 * 60_000 });
		ok = res.code === 0 && fs.existsSync(out) && fs.statSync(out).size > 0;
	}
	if (!ok) return undefined;
	process.stderr.write("      已分离音轨 -> audio.m4a\n");
	return out;
}

/** 读取媒体时长（秒）。 */
async function mediaDuration(file) {
	const ff = resolveFfmpeg("ffprobe");
	if (!ff.cmd) return 0;
	const res = await run([ff.cmd, "-v", "error", "-show_entries", "format=duration",
		"-of", "default=nw=1:nk=1", file], { timeoutMs: 60_000 });
	const value = Number.parseFloat(res.stdout.trim());
	return Number.isFinite(value) ? value : 0;
}

// ---------------------------------------------------------------------------
// 抽帧与接触印相纸
// ---------------------------------------------------------------------------

/**
 * 抽关键帧。
 * 速度要点：读取耗时主要取决于像素数而非文件体积。640×360 ≈ 23 万像素，
 * 读取速度约为 960 宽的两倍，字幕/人脸/动作都还能辨认。
 * @returns {Promise<{frames: string[], every: number, duration: number}>}
 */
export async function extractFrames(video, dest, { every = 3, width = 640, maxFrames = 192 } = {}) {
	const ff = resolveFfmpeg("ffmpeg");
	if (!ff.cmd) throw new Error(ff.hint);
	const frameDir = path.join(dest, "frames");
	await fsp.mkdir(frameDir, { recursive: true });
	const duration = await mediaDuration(video);
	let interval = every;
	if (duration > 0 && duration / interval > maxFrames) {
		interval = Math.ceil(duration / maxFrames);
		process.stderr.write(`      视频 ${clock(duration)} 较长，抽帧间隔由 ${every}s 放宽到 ${interval}s 以覆盖全片\n`);
	}
	process.stderr.write(`[2/3] 抽帧中… 每 ${interval}s 一张，宽 ${width}px\n`);
	const res = await run([ff.cmd, "-hide_banner", "-loglevel", "error", "-y",
		"-i", video,
		"-vf", `fps=1/${interval},scale=${width}:-2`,
		"-frames:v", String(maxFrames),
		"-q:v", "4",
		path.join(frameDir, "f_%05d.jpg")], { timeoutMs: 60 * 60_000, label: "ffmpeg" });
	if (res.code !== 0) {
		throw new Error(`抽帧失败:\n${(res.stderr || "").trim().split(/\r?\n/).slice(-6).join("\n")}`);
	}
	const frames = (await fsp.readdir(frameDir)).filter((n) => n.startsWith("f_") && n.endsWith(".jpg")).sort();
	const index = frames.map((name, i) => `${name}\t${clock(i * interval)}`);
	// 表头刻意用 ASCII：消费方若按 GBK 解码中文会变成乱码，而这一行是给模型读的定位信息。
	await fsp.writeFile(path.join(dest, "frames_index.txt"),
		`# interval=${interval}s count=${frames.length} (time = video-relative mm:ss)\n${index.join("\n")}\n`, "utf8");
	const covered = frames.length * interval;
	const warn = duration > 0 && covered < duration - interval ? "  ⚠ 未覆盖全片" : "";
	process.stderr.write(`      完成 ${frames.length} 张，覆盖 0~${clock(covered)}${warn}\n`);
	return { frames: frames.map((n) => path.join(frameDir, n)), every: interval, duration };
}

/**
 * 把关键帧拼成 N 宫格「接触印相纸」。
 *
 * 为什么快：每次 read_image 都是一次独立的图像请求，逐张读 192 帧 = 192 次请求；
 * 拼成 4×4 后只要 12 次（约 1/16）。代价是格内小字会糊，所以配「两遍法」使用：
 * 先读拼图扫全片定位，再对关键格回读单张全分辨率。
 * @returns {Promise<{sheets: string[], grid: string, count: number}>}
 */
export async function makeContactSheets(dest, { cols = 4, rows = 4, cellWidth = 384, every = 3 } = {}) {
	const ff = resolveFfmpeg("ffmpeg");
	if (!ff.cmd) throw new Error(ff.hint);
	const frameDir = path.join(dest, "frames");
	if (!fs.existsSync(frameDir)) return { sheets: [], grid: `${cols}x${rows}`, count: 0 };
	const frames = (await fsp.readdir(frameDir)).filter((n) => n.startsWith("f_") && n.endsWith(".jpg")).sort();
	if (frames.length === 0) return { sheets: [], grid: `${cols}x${rows}`, count: 0 };
	const perSheet = cols * rows;
	const cellHeight = Math.floor((cellWidth * 9) / 16 / 2) * 2;
	const sheetDir = path.join(dest, "sheets");
	await fsp.mkdir(sheetDir, { recursive: true });
	// 表头与行标记刻意用 ASCII：消费方若按 GBK 解码中文会变成乱码，
	// 而这个文件是「两遍法」定位画面用的，读错就等于白读。
	const indexLines = [
		"# contact sheet index: read these sheets first to scan the whole video,",
		"# then re-read individual full-resolution frames for details",
		`# cell=${cellWidth}x${cellHeight} grid=${cols}x${rows} order=left-to-right,top-to-bottom`,
		""
	];
	const sheets = [];
	for (let start = 0; start < frames.length; start += perSheet) {
		const batch = frames.slice(start, start + perSheet);
		const ordinal = sheets.length + 1;
		const name = `sheet_${String(ordinal).padStart(3, "0")}.jpg`;
		const listFile = path.join(sheetDir, `_list_${String(ordinal).padStart(3, "0")}.txt`);
		// ffmpeg concat 列表必须无 BOM，且路径用正斜杠
		await fsp.writeFile(listFile,
			batch.map((f) => `file '${path.join(frameDir, f).replaceAll("\\", "/")}'`).join("\n"), "utf8");
		const out = path.join(sheetDir, name);
		const res = await run([ff.cmd, "-hide_banner", "-loglevel", "error", "-y",
			"-f", "concat", "-safe", "0", "-i", listFile,
			"-vf", `scale=${cellWidth}:${cellHeight},tile=${cols}x${rows}`,
			"-frames:v", "1", "-q:v", "3", out], { timeoutMs: 10 * 60_000 });
		await fsp.rm(listFile, { force: true });
		if (res.code !== 0 || !fs.existsSync(out)) {
			process.stderr.write(`      拼图 ${name} 失败\n`);
			continue;
		}
		sheets.push(out);
		indexLines.push(`== ${name} ==`);
		batch.forEach((file, i) => {
			const n = Number.parseInt(file.slice(2, 7), 10);
			const seconds = (n - 1) * every;
			const row = Math.floor(i / cols) + 1;
			const col = (i % cols) + 1;
			indexLines.push(`  r${row}c${col}  ${clock(seconds)}  (${file})`);
		});
		indexLines.push("");
	}
	await fsp.writeFile(path.join(dest, "sheets_index.txt"), indexLines.join("\n"), "utf8");
	process.stderr.write(`      拼图完成 ${sheets.length} 张 -> sheets\\（读取次数 ${frames.length} → ${sheets.length}）\n`);
	return { sheets, grid: `${cols}x${rows}`, count: sheets.length };
}

// ---------------------------------------------------------------------------
// 转写
// ---------------------------------------------------------------------------

/**
 * 抓取 UP 主自己上传的字幕/CC（最准、免费，但常常没有）。
 * 走 yt-dlp 的 --write-subs --skip-download。
 * @returns {Promise<{text: string, lang: string, file: string}|undefined>}
 */
async function fetchCreatorSubtitles(url, dest, cookies) {
	const yt = await resolveYtDlp();
	if (yt.kind === "missing") return undefined;
	const argv = [...yt.cmd, "--no-warnings", "--no-playlist", "--skip-download",
		"--write-subs", "--write-auto-subs", "--sub-langs", "all", "--sub-format", "vtt/srt/best",
		"-o", path.join(dest, "sub.%(ext)s"), ...cookieArgs(url, cookies), url];
	const res = await run(argv, { timeoutMs: 5 * 60_000, quiet: true, env: { ...yt.env, ...proxyEnv(url) } });
	const candidates = (await fsp.readdir(dest)).filter((n) => /^sub\..*\.(vtt|srt|json3|srv3|ttml)$/i.test(n));
	if (res.code !== 0 && candidates.length === 0) return undefined;
	const chosen = candidates.sort((a, b) => Number(b.includes(".zh")) - Number(a.includes(".zh")))[0];
	if (!chosen) return undefined;
	const raw = await fsp.readFile(path.join(dest, chosen), "utf8");
	const text = parseSubtitle(raw, chosen);
	if (text.trim() === "") return undefined;
	const lang = chosen.replace(/^sub\./, "").replace(/\.(vtt|srt|json3|srv3|ttml)$/i, "");
	return { text, lang, file: chosen };
}

/** 把 VTT / SRT / json3 字幕解析成「[起-止] 文本」清单。 */
function parseSubtitle(raw, name) {
	if (/\.json3$/i.test(name)) {
		try {
			const data = JSON.parse(raw);
			const lines = [];
			for (const event of data.events ?? []) {
				const text = (event.segs ?? []).map((s) => s.utf8 ?? "").join("").trim();
				if (text === "") continue;
				const start = (event.tStartMs ?? 0) / 1000;
				const end = start + (event.dDurationMs ?? 0) / 1000;
				lines.push(`[${start.toFixed(1)}-${end.toFixed(1)}] ${text}`);
			}
			return lines.join("\n");
		} catch {
			return "";
		}
	}
	const out = [];
	for (const block of raw.split(/\r?\n\r?\n/)) {
		const rows = block.split(/\r?\n/).filter((r) => r.trim() !== "");
		const stampRow = rows.find((r) => r.includes("-->"));
		if (!stampRow) continue;
		const [from, to] = stampRow.split("-->").map((v) => v.trim().split(" ")[0]);
		const text = rows.slice(rows.indexOf(stampRow) + 1).join(" ")
			.replace(/<[^>]+>/g, "")
			.replace(/&nbsp;/g, " ")
			.replace(/&amp;/g, "&")
			.replace(/&lt;/g, "<")
			.replace(/&gt;/g, ">")
			.trim();
		if (text === "") continue;
		out.push(`[${hmsToSeconds(from).toFixed(1)}-${hmsToSeconds(to).toFixed(1)}] ${text}`);
	}
	return out.join("\n");
}

function hmsToSeconds(value) {
	const m = /^(?:(\d+):)?(\d+):(\d+)[.,](\d+)$/.exec(value.trim());
	if (!m) return 0;
	return Number(m[1] ?? 0) * 3600 + Number(m[2]) * 60 + Number(m[3]) + Number(m[4].padEnd(3, "0").slice(0, 3)) / 1000;
}

/**
 * 解析 ASR 命令模板。
 *
 * 约定：模板里的 {audio} 替换成音频绝对路径，{out} 替换成输出 txt 路径；
 * 若模板不含 {out}，则把子进程 stdout 当作转写文本。
 * 例如：
 *   VIDEOSUM_ASR_CMD="python -m faster_whisper_cli {audio} --out {out}"
 */
function asrCommandTemplate() {
	return process.env.VIDEOSUM_ASR_CMD ?? "";
}

/**
 * 给 faster-whisper 选一个模型缓存目录，避免落进不可写的 %USERPROFILE%\.cache。
 * 优先沿用工作区里已有的 .hf_cache（里面通常已经下过模型，能省掉一次下载）。
 */
function asrEnv() {
	if (process.env.HF_HOME) return { HF_HOME: process.env.HF_HOME };
	const workspace = process.env.WORKSPACE_DIR ?? process.cwd();
	const shared = path.join(workspace, ".hf_cache");
	if (fs.existsSync(path.join(shared, "hub"))) return { HF_HOME: shared };
	return { HF_HOME: path.join(pluginDataDir(), "hf_cache") };
}

/**
 * 探测一个可用的 ASR。优先级：
 *   1. VIDEOSUM_ASR_CMD —— 用户显式指定，永远最优先
 *   2. 本地 faster-whisper + 内置助手脚本
 *   3. 都没有 → undefined（调用方会退回「只有画面素材」）
 * @returns {{template: string, env?: object, source: string}|undefined}
 */
export function resolveAsr() {
	const explicit = asrCommandTemplate();
	if (explicit) return { template: explicit, source: "env" };

	if (process.env.VIDEOSUM_ASR_DISABLE === "1") return undefined;

	const helper = fileURLToPath(new URL("./asr/faster_whisper_asr.py", import.meta.url));
	if (!fs.existsSync(helper)) return undefined;

	for (const py of pythonCandidates()) {
		const probe = probeSync(py, ["-c", "import faster_whisper"], undefined);
		if (!probe.ok) continue;

		const model = process.env.VIDEOSUM_ASR_MODEL ?? "small";
		const lang = process.env.VIDEOSUM_ASR_LANG ?? "";
		const template = [
			`"${py}"`,
			`"${helper}"`,
			"--audio", `"{audio}"`,
			"--out", `"{out}"`,
			"--model", model,
			...(lang === "" ? [] : ["--lang", lang])
		].join(" ");

		return { template, env: asrEnv(), source: `faster-whisper/${path.basename(py)}` };
	}
	return undefined;
}

function splitCommand(template) {
	// 只做朴素切分（引号包裹的片段保留），足够覆盖 python -m xxx / 可执行文件 这类命令。
	const parts = [];
	const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
	let m;
	while ((m = re.exec(template)) !== null) parts.push(m[1] ?? m[2] ?? m[3]);
	return parts;
}

/**
 * 用外部 ASR 命令转写音频。
 * @returns {Promise<{text: string, engine: string}|undefined>}
 */
async function transcribeWithCommand(audio, dest, spec) {
	const template = typeof spec === "string" ? spec : spec.template;
	const env = typeof spec === "string" ? undefined : spec.env;
	const argv = splitCommand(template).map((part) =>
		part.replaceAll("{audio}", audio).replaceAll("{out}", path.join(dest, "transcript.txt")));
	if (argv.length === 0) return undefined;
	process.stderr.write(`[3/3] 转写中…（外部 ASR：${argv[0]}）\n`);
	const usesOutFile = template.includes("{out}");
	const res = await run(argv, { timeoutMs: 4 * 60 * 60_000, label: "asr", ...(env ? { env } : {}) });
	if (res.code !== 0) {
		process.stderr.write(`      外部 ASR 失败（退出码 ${res.code}），跳过转写\n`);
		return undefined;
	}
	let text = usesOutFile && fs.existsSync(path.join(dest, "transcript.txt"))
		? await fsp.readFile(path.join(dest, "transcript.txt"), "utf8")
		: res.stdout;
	text = text.trim();
	if (text === "") return undefined;
	return { text, engine: path.basename(argv[0]) };
}

/** 把「[起-止] 文本」清单落成 transcript.txt 与 transcript.srt。 */
async function writeTranscript(dest, lines, meta) {
	await fsp.writeFile(path.join(dest, "transcript.txt"), lines.join("\n") + "\n", "utf8");
	const srt = [];
	lines.forEach((line, i) => {
		const m = /^\[([\d.]+)-([\d.]+)\]\s*(.*)$/.exec(line);
		if (!m) return;
		srt.push(`${i + 1}\n${srtStamp(Number(m[1]))} --> ${srtStamp(Number(m[2]))}\n${m[3]}\n`);
	});
	if (srt.length > 0) await fsp.writeFile(path.join(dest, "transcript.srt"), srt.join("\n"), "utf8");
	await fsp.writeFile(path.join(dest, "transcript.meta.json"), JSON.stringify(meta, null, 2), "utf8");
}

// ---------------------------------------------------------------------------
// 命令实现
// ---------------------------------------------------------------------------

/**
 * probe：只取元数据，不下载。
 * @returns {Promise<object>} 结果对象。
 */
export async function probe({ url, out, cookies }) {
	const yt = await resolveYtDlp();
	if (yt.kind === "missing") throw new Error(yt.hint);
	const argv = [...yt.cmd, "--no-warnings", "--no-playlist", "--skip-download", "--dump-single-json",
		...cookieArgs(url, cookies), url];
	const res = await run(argv, { timeoutMs: 3 * 60_000, label: "yt-dlp", env: { ...yt.env, ...proxyEnv(url) } });
	if (res.code !== 0) {
		throw new Error(`取元数据失败（yt-dlp 退出码 ${res.code}）:\n${(res.stderr || "").trim().split(/\r?\n/).slice(-6).join("\n")}`);
	}
	const info = JSON.parse(res.stdout);
	const result = {
		url,
		id: info.id,
		title: info.title,
		uploader: info.uploader ?? info.channel,
		duration: info.duration,
		durationClock: info.duration ? clock(info.duration) : undefined,
		viewCount: info.view_count,
		likeCount: info.like_count,
		uploadDate: info.upload_date,
		description: info.description,
		tags: info.tags,
		chapters: info.chapters?.map((c) => ({ title: c.title, start: c.start_time })),
		subtitleLangs: Object.keys(info.subtitles ?? {}),
		autoSubtitleLangs: Object.keys(info.automatic_captions ?? {})
	};
	if (out) {
		await fsp.mkdir(out, { recursive: true });
		await fsp.writeFile(path.join(out, "meta.json"), JSON.stringify(result, null, 2), "utf8");
	}
	return result;
}

/**
 * material：一条龙准备素材。
 * @param {object} options 见脚本头部注释。
 * @returns {Promise<object>} 结果对象，含各产物的绝对路径。
 */
export async function material(options) {
	const {
		url, out, every = 3, width = 640, maxFrames = 192, grid = "4x4", cell = 384,
		audioOnly = false, sheets = true, asr = true, cookies, lang, quality = 1080,
		transcribeCommand
	} = options;
	const yt = await resolveYtDlp();
	const missing = [
		yt.kind === "missing" ? `yt-dlp: ${yt.hint}` : undefined,
		resolveFfmpeg("ffmpeg").hint,
		resolveFfmpeg("ffprobe").hint
	].filter(Boolean);
	const title = (await probeTitle(url, cookies)) || "video";
	const dest = out ?? path.resolve(process.cwd(), "vidsum_out", slugify(title));
	await fsp.mkdir(dest, { recursive: true });
	process.stderr.write(`目标: ${url}\n输出: ${dest}\n`);

	const { info, media } = await downloadMedia({ url, dest, audioOnly, quality, cookies });
	const meta = {
		url,
		id: info.id,
		title: info.title ?? title,
		uploader: info.uploader ?? info.channel,
		duration: info.duration,
		viewCount: info.view_count,
		likeCount: info.like_count,
		uploadDate: info.upload_date,
		webpageUrl: info.webpage_url ?? url,
		description: info.description,
		tags: info.tags,
		chapters: info.chapters?.map((c) => ({ title: c.title, start: c.start_time }))
	};
	await fsp.writeFile(path.join(dest, "meta.json"), JSON.stringify(meta, null, 2), "utf8");

	let audio;
	if (audioOnly) {
		audio = media ?? pickMedia(dest, MEDIA_EXT.audio, "audio");
	} else {
		if (media) {
			const { cols, rows } = parseGrid(grid);
			const frameResult = await extractFrames(media, dest, { every, width, maxFrames });
			if (sheets) await makeContactSheets(dest, { cols, rows, cellWidth: cell, every: frameResult.every });
		}
		audio = pickMedia(dest, MEDIA_EXT.audio, "audio") ?? (media ? await extractAudio(media, dest) : undefined);
	}

	let transcript;
	if (audio && asr !== false) {
		const creator = await fetchCreatorSubtitles(url, dest, cookies);
		if (creator) {
			process.stderr.write(`      使用站方字幕（${creator.lang}），跳过 ASR\n`);
			const lines = creator.text.split("\n");
			await writeTranscript(dest, lines, { url, source: "creator-subtitle", lang: creator.lang, file: creator.file });
			transcript = { source: "creator-subtitle", lang: creator.lang, lines: lines.length, engine: "yt-dlp" };
		} else {
			const asrSpec = transcribeCommand
				? { template: transcribeCommand, source: "explicit" }
				: resolveAsr();
			if (asrSpec) {
				const asrResult = await transcribeWithCommand(audio, dest, asrSpec);
				if (asrResult) {
					const lines = asrResult.text.split(/\r?\n/).filter((l) => l.trim() !== "");
					await writeTranscript(dest, lines, { url, source: "asr", lang: lang ?? "auto", engine: asrResult.engine });
					transcript = { source: "asr", lang: lang ?? "auto", lines: lines.length, engine: asrResult.engine };
				}
			}
		}
	}
	if (!transcript) {
		process.stderr.write("      无转写（未找到 ASR 且站方无字幕）—— 仍然返回画面素材\n");
	}

	const result = {
		ok: true,
		url,
		outDir: dest,
		title: meta.title,
		uploader: meta.uploader,
		duration: meta.duration,
		audio: audio ?? null,
		transcript: transcript ?? null,
		transcriptFile: transcript ? path.join(dest, "transcript.txt") : null,
		framesDir: fs.existsSync(path.join(dest, "frames")) ? path.join(dest, "frames") : null,
		sheetsDir: fs.existsSync(path.join(dest, "sheets")) ? path.join(dest, "sheets") : null,
		sheetsIndex: fs.existsSync(path.join(dest, "sheets_index.txt")) ? path.join(dest, "sheets_index.txt") : null,
		framesIndex: fs.existsSync(path.join(dest, "frames_index.txt")) ? path.join(dest, "frames_index.txt") : null,
		metaFile: path.join(dest, "meta.json"),
		missingTools: missing
	};
	return result;
}

function parseGrid(grid) {
	const m = /^(\d+)\s*[x×*]\s*(\d+)$/i.exec(String(grid).trim());
	if (!m) return { cols: 4, rows: 4 };
	return { cols: Math.max(1, Number(m[1])), rows: Math.max(1, Number(m[2])) };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parseArgs(argv) {
	const out = { _: [] };
	for (let i = 0; i < argv.length; i++) {
		const token = argv[i];
		if (!token.startsWith("--")) {
			out._.push(token);
			continue;
		}
		const key = token.slice(2);
		const next = argv[i + 1];
		if (next === undefined || next.startsWith("--")) {
			out[key] = true;
			continue;
		}
		out[key] = next;
		i++;
	}
	return out;
}

async function main() {
	const argv = process.argv.slice(2);
	const command = argv[0];
	const args = parseArgs(argv.slice(1));
	const emit = (value) => process.stdout.write(JSON.stringify(value, null, 2) + "\n");
	try {
		switch (command) {
			case "probe": {
				if (!args.url) throw new Error("probe 需要 --url");
				emit(await probe({ url: args.url, out: args.out, cookies: args.cookies }));
				break;
			}
			case "material": {
				if (!args.url) throw new Error("material 需要 --url");
				emit(await material({
					url: args.url,
					out: args.out,
					every: numberOr(args.every, 3),
					width: numberOr(args.width, 640),
					maxFrames: numberOr(args["max-frames"], 192),
					grid: args.grid ?? "4x4",
					cell: numberOr(args.cell, 384),
					audioOnly: args["audio-only"] === true,
					sheets: args["no-sheets"] !== true,
					asr: args["no-asr"] !== true,
					cookies: args.cookies,
					lang: args.lang,
					quality: numberOr(args.quality, 1080)
				}));
				break;
			}
			case "frames": {
				if (!args.video) throw new Error("frames 需要 --video");
				const dest = args.out ?? path.dirname(args.video);
				const result = await extractFrames(args.video, dest, {
					every: numberOr(args.every, 3),
					width: numberOr(args.width, 640),
					maxFrames: numberOr(args["max-frames"], 192)
				});
				const { cols, rows } = parseGrid(args.grid ?? "4x4");
				const sheetResult = args["no-sheets"] === true
					? { sheets: [], count: 0 }
					: await makeContactSheets(dest, { cols, rows, cellWidth: numberOr(args.cell, 384), every: result.every });
				emit({ ok: true, outDir: dest, frames: result.frames.length, every: result.every, sheets: sheetResult.count });
				break;
			}
			case "transcribe": {
				if (!args.audio) throw new Error("transcribe 需要 --audio");
				const dest = args.out ?? path.dirname(args.audio);
				if (args.url) {
					const creator = await fetchCreatorSubtitles(args.url, dest, args.cookies);
					if (creator) {
						const lines = creator.text.split("\n");
						await writeTranscript(dest, lines, { url: args.url, source: "creator-subtitle", lang: creator.lang });
						emit({ ok: true, source: "creator-subtitle", lang: creator.lang, lines: lines.length });
						break;
					}
				}
				const asrSpec = resolveAsr();
				if (!asrSpec) {
					emit({ ok: false, reason: "no-asr", hint: "未找到 ASR：pip install faster-whisper，或设置 VIDEOSUM_ASR_CMD" });
					break;
				}
				const asrResult = await transcribeWithCommand(args.audio, dest, asrSpec);
				if (!asrResult) {
					emit({ ok: false, reason: "asr-failed" });
					break;
				}
				const lines = asrResult.text.split(/\r?\n/).filter((l) => l.trim() !== "");
				await writeTranscript(dest, lines, { source: "asr", lang: args.lang ?? "auto", engine: asrResult.engine });
				emit({ ok: true, source: "asr", engine: asrResult.engine, lines: lines.length });
				break;
			}
			case "doctor": {
				const yt = await resolveYtDlp();
				emit({
					ok: Boolean(yt.cmd.length > 0 && resolveFfmpeg("ffmpeg").cmd),
					node: process.version,
					platform: `${process.platform}-${process.arch}`,
					ytDlp: { kind: yt.kind, cmd: yt.cmd, version: yt.version, lib: yt.lib, hint: yt.hint },
					ffmpeg: { cmd: resolveFfmpeg("ffmpeg").cmd, hint: resolveFfmpeg("ffmpeg").hint },
					ffprobe: { cmd: resolveFfmpeg("ffprobe").cmd, hint: resolveFfmpeg("ffprobe").hint },
					asr: resolveAsr()?.source ?? null,
					version: VERSION
				});
				break;
			}
			case undefined:
			case "--help":
			case "-h":
			case "help":
				process.stdout.write(usage());
				break;
			default:
				throw new Error(`未知子命令: ${command}`);
		}
	} catch (error) {
		process.stderr.write(`\n错误: ${error instanceof Error ? error.message : String(error)}\n`);
		emit({ ok: false, error: error instanceof Error ? error.message : String(error) });
		process.exitCode = 1;
	}
}

function numberOr(value, fallback) {
	const n = Number(value);
	return Number.isFinite(n) && n > 0 ? n : fallback;
}

function usage() {
	return `video-material.mjs v${VERSION} —— 视频 -> 可总结素材

子命令:
  doctor                       检查 yt-dlp / ffmpeg / ASR 是否就绪
  probe      --url URL         只取元数据
  material   --url URL         下载 + 抽帧 + 拼图 + 转写（推荐）
  frames     --video FILE      对已有视频抽帧 + 拼图
  transcribe --audio FILE      对已有音轨转写（字幕优先）

常用参数:
  --out DIR          输出目录（默认 ./vidsum_out/<标题>）
  --every N          抽帧间隔秒（默认 3）
  --width N          关键帧宽度像素（默认 640；960 更清晰、480 更快）
  --max-frames N     最多抽多少张（默认 192，超出自动放宽间隔）
  --grid 4x4         拼图网格
  --cell N           拼图每格宽度像素（默认 384）
  --no-sheets        不生成拼图
  --no-asr           不转写（只要画面素材）
  --audio-only       只下音频（省流量）
  --quality N        视频最大高度（默认 1080；0=最高）
  --cookies FILE     显式指定 cookies.txt
  --lang zh          转写语言提示

环境变量:
  VIDEOSUM_YTDLP      yt-dlp 可执行文件
  VIDEOSUM_FFMPEG     ffmpeg 可执行文件
  VIDEOSUM_FFPROBE    ffprobe 可执行文件
  VIDEOSUM_ASR_CMD    ASR 命令模板，{audio} / {out} 会被替换
  VIDEOSUM_PYLIBS     含 yt_dlp 包的目录（等价 PYTHONPATH）
  VIDEOSUM_COOKIE_DIR 存放 bilibili.txt 等 cookies 的目录
  WORKSPACE_DIR      工作区根目录（用于自动发现 .pylibs 与 cookies/）
`;
}

const isDirectRun = process.argv[1] !== undefined
	&& path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));

if (isDirectRun) {
	main().catch((error) => {
		process.stderr.write(`${error?.stack ?? error}\n`);
		process.exitCode = 1;
	});
}

export { VERSION, clock as formatClock, parseGrid };
