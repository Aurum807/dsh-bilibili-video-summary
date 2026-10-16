/**
 * dsh-bilibili-video-summary —— DSH 插件入口。
 *
 * 做三件事：
 *  1. 注册工具 `video_material`：把视频链接变成可总结的素材（元数据 / 转写 / 关键帧 + 拼图）。
 *  2. 注册 skill `bilibili-video-summary`：总结方法论（结论先行、时间轴、画面对照、存疑标注）。
 *  3. 监听 `agent/pre-step`：当用户只发了一条 B 站链接、没提任何要求时，自动把该 skill
 *     作为 user 角色指令注入这一步，实现「贴链接即总结」。用户明确说了要干什么时不动手。
 *
 * 契约依据（DSH 0.2.0-rc.2）：
 *  - defineTool 来自 @deepseek-ai/dsh-tools；ctx.tools.register(tool)
 *  - createUserMessage 来自 @deepseek-ai/dsh-llm
 *  - renderSkillContent 来自 @deepseek-ai/dsh-skill
 *  - ctx.skills.register({ name, description, content, invocation, resourceBase })
 */

import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { defineTool } from "@deepseek-ai/dsh-tools";
import { createUserMessage } from "@deepseek-ai/dsh-llm";
import { renderSkillContent } from "@deepseek-ai/dsh-skill";
import { material, probe, VERSION } from "./video-material.mjs";

export const name = "dsh-bilibili-video-summary";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SKILL_NAME = "bilibili-video-summary";

/** B 站视频/直播回放/短链的识别式。只认链接形态，不做站点白名单判断。 */
const BILIBILI_PATTERN = /https?:\/\/(?:www\.|m\.|live\.)?bilibili\.com\/[^\s<>"']+|https?:\/\/b23\.tv\/[A-Za-z0-9]+/i;

/** 用户明确交代了任务时就不自动注入（这些词说明他要的是别的动作）。 */
const EXPLICIT_INTENT = /总结|摘(?:要|录)|概括|讲(?:了)?(?:什么|啥)|内容|字幕|转(?:写|录)|提(?:取|炼)|翻译|评论|评价|对比|怎么看|为什么|为什么/;

/** 一句话里除了链接还有多少实质内容；全是链接/空白就算「只发了链接」。 */
function isBareLink(content) {
	const stripped = content.replace(BILIBILI_PATTERN, "").replace(/[\s，,。.、:：!！?？~～\-—_()（）[\]【】]/g, "");
	return stripped.length <= 6 && !EXPLICIT_INTENT.test(stripped);
}

/** 把消息的 content 归一成纯文本（content 可能是字符串或 part 数组）。 */
function textOf(message) {
	const content = message?.content;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((part) => part?.type === "text" && typeof part.text === "string")
		.map((part) => part.text)
		.join("\n");
}

/**
 * 找这一步新提到的、且需要自动总结的 B 站链接。
 * 只看这一批 claimed 消息里的用户输入；已经处理过的历史不会重复触发，
 * 因为每次 pre-step 只拿到当前新被认领的消息。
 * @returns {string|undefined} 命中的链接。
 */
function autoTriggerUrl(messages) {
	for (const message of messages ?? []) {
		if (message?.role !== undefined && message.role !== "user") continue;
		const text = textOf(message);
		if (text === "" || !BILIBILI_PATTERN.test(text)) continue;
		if (!isBareLink(text)) continue;
		return BILIBILI_PATTERN.exec(text)?.[0];
	}
	return undefined;
}

export function apply(ctx) {
	// ---------------------------------------------------------------------
	// 1. 工具：准备素材
	// ---------------------------------------------------------------------
	ctx.tools.register(defineTool({
		name: "video_material",
		description: [
			"把一个视频链接变成可总结的素材：元数据、时间轴转写稿、关键帧缩略图与拼图（接触印相纸）。",
			"适用于 B 站以及 yt-dlp 支持的其他站点。",
			"先用 action=probe 确认这是目标视频并拿到标题/时长；再用 action=material 准备完整素材。",
			"拿到素材后：读 sheets/ 下的拼图通读全片画面（每张含 16 格，比逐张读图快十几倍），",
			"对关键片段再回读 frames/ 下的单张全分辨率图核对文字与数据。",
			"注意：转写稿由语音识别产出，人名、型号、专业名词常出错，必须以画面文字为准。"
		].join(" "),
		parameters: {
			action: {
				type: "string",
				required: true,
				enum: ["probe", "material"],
				description: "probe 只取元数据；material 下载并准备全部素材。"
			},
			url: {
				type: "string",
				required: true,
				description: "视频地址，例如 https://www.bilibili.com/video/BVxxxxxxxxx/"
			},
			every: {
				type: "number",
				description: "抽帧间隔秒数，默认 3。画面变化快（演示、游戏）调小，口播访谈调大。"
			},
			audioOnly: {
				type: "boolean",
				description: "只下载音频、不抽帧。仅当只需要文字内容时使用。"
			},
			lang: {
				type: "string",
				description: "转写语言提示，如 zh。留空由识别引擎自动判断。"
			}
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				required: ["ok"],
				properties: {
					ok: { type: "boolean", required: true },
					action: { type: "string" },
					error: { type: "string" },
					hint: { type: "string" },
					title: { type: "string" },
					uploader: { type: "string" },
					duration: { type: "number" },
					outDir: { type: "string" },
					transcriptFile: { type: "string" },
					sheetsDir: { type: "string" },
					sheetsIndex: { type: "string" },
					framesDir: { type: "string" },
					framesIndex: { type: "string" },
					metaFile: { type: "string" },
					transcriptSource: { type: "string" }
				}
			},
			render: (_args, value) => [{ type: "text", text: renderResult(value) }]
		},
		async execute(args) {
			if (args.action === "probe") {
				try {
					const info = await probe({ url: args.url });
					return {
						ok: true,
						action: "probe",
						title: info.title,
						uploader: info.uploader,
						duration: info.duration,
						hint: info.subtitleLangs.length > 0
							? `站方有字幕（${info.subtitleLangs.join(", ")}），material 会优先使用它，比语音识别准确。`
							: "站方无字幕，将使用语音识别；人名与型号需对照画面核对。"
					};
				} catch (error) {
					return { ok: false, action: "probe", error: message(error) };
				}
			}
			try {
				const result = await material({
					url: args.url,
					every: args.every,
					audioOnly: args.audioOnly === true,
					lang: args.lang
				});
				return {
					ok: true,
					action: "material",
					title: result.title,
					uploader: result.uploader,
					duration: result.duration,
					outDir: result.outDir,
					transcriptFile: result.transcriptFile ?? undefined,
					transcriptSource: result.transcript?.source,
					sheetsDir: result.sheetsDir ?? undefined,
					sheetsIndex: result.sheetsIndex ?? undefined,
					framesDir: result.framesDir ?? undefined,
					framesIndex: result.framesIndex ?? undefined,
					metaFile: result.metaFile,
					hint: result.missingTools.length > 0 ? `缺少外部工具：${result.missingTools.join("；")}` : undefined
				};
			} catch (error) {
				return { ok: false, action: "material", error: message(error) };
			}
		}
	}));

	// ---------------------------------------------------------------------
	// 2. Skill：总结方法论
	// ---------------------------------------------------------------------
	const skillText = SKILL_BODY;
	ctx.skills.register({
		name: SKILL_NAME,
		description: "总结 B 站/视频链接的内容：先用 video_material 取出转写与关键帧，再产出结论先行的中文总结，含时间轴与画面对照校正。",
		content: skillText,
		resourceBase: { kind: "directory", path: HERE }
	});

	// ---------------------------------------------------------------------
	// 3. 只发链接就自动总结
	// ---------------------------------------------------------------------
	ctx.on("agent/pre-step", async ({ messages, signal }, next) => {
		const decision = await next();
		if (decision.kind === "reject") return decision;
		const url = autoTriggerUrl(messages);
		if (url === undefined) return decision;
		signal?.throwIfAborted?.();
		const injection = createUserMessage({
			content: [{
				type: "text",
				text: [
					renderSkillContent({ name: SKILL_NAME, provider: name, content: skillText }),
					"",
					`<auto_trigger reason="用户在消息里只提供了视频链接，没有附加任何其他要求">`,
					`目标链接：${url}`,
					"按上面的 skill 说明，直接开始总结这个视频，不要先反问用户想要什么。",
					"</auto_trigger>"
				].join("\n")
			}],
			source: { kind: `plugin:${name}`, plugin: name, form: "snapshot", sections: [{ name: SKILL_NAME, text: skillText }] }
		});
		return { ...decision, messages: [...decision.messages, injection] };
	});
}

function message(error) {
	return error instanceof Error ? error.message : String(error);
}

/** 工具结果渲染成模型看得懂的简短文本。 */
function renderResult(value) {
	if (value.ok === false) {
		return `素材准备失败：${value.error ?? "未知错误"}`;
	}
	if (value.action === "probe") {
		return [
			`标题：${value.title ?? "(未知)"}`,
			`作者：${value.uploader ?? "(未知)"}`,
			`时长：${value.duration !== undefined ? `${Math.round(value.duration)} 秒` : "(未知)"}`,
			value.hint ?? ""
		].filter(Boolean).join("\n");
	}
	const lines = [
		`素材已就绪：${value.title ?? ""}`,
		value.outDir !== undefined ? `目录：${value.outDir}` : "",
		value.transcriptFile !== undefined
			? `转写稿：${value.transcriptFile}（来源：${value.transcriptSource ?? "未知"}）`
			: "转写稿：无（未配置语音识别，且站方无字幕）",
		value.sheetsIndex !== undefined ? `拼图索引：${value.sheetsIndex}` : "",
		value.sheetsDir !== undefined ? `拼图目录：${value.sheetsDir}` : "",
		value.framesIndex !== undefined ? `单帧索引：${value.framesIndex}` : "",
		value.framesDir !== undefined ? `单帧目录：${value.framesDir}` : "",
		"下一步：先读 sheets/ 里的拼图通读全片画面，再对关键片段回读 frames/ 里的单张全分辨率图。",
		value.hint ?? ""
	];
	return lines.filter(Boolean).join("\n");
}

const SKILL_BODY = `# 视频总结

把一条视频链接变成一份让人看得懂、且经得起核对的总结。

## 先取素材

调用 \`video_material\`：

1. \`action=probe\` —— 确认标题、作者、时长。若用户给的链接不是他想说的那个视频，先说清楚。
2. \`action=material\` —— 下载并准备：转写稿 \`transcript.txt\`、关键帧 \`frames/\`、拼图 \`sheets/\`。

素材目录里有什么：

| 文件 | 用途 |
| --- | --- |
| \`meta.json\` | 标题、作者、时长、简介、章节 |
| \`transcript.txt\` | \`[起-止] 文本\` 逐段时间轴转写 |
| \`sheets_index.txt\` | 拼图索引：\`r{行}c{列} 时间 (帧文件)\`；表头是 ASCII，避免编码误读 |
| \`sheets/sheet_*.jpg\` | 每张 16 格关键帧拼图（4×4） |
| \`frames/f_*.jpg\` | 单张全分辨率关键帧 |
| \`frames_index.txt\` | 单帧与时间点对应表（表头同样是 ASCII） |

## 两遍法读画面（这条最重要）

**第一遍**：只读 \`sheets/\` 里的拼图。一份 20 分钟视频大约 12～19 张拼图，比逐张读图快十几倍，
足以看清全片结构：是口播、实拍演示、录屏文档还是素材混剪，以及每段在讲什么。

**第二遍**：对关键片段回读 \`frames/\` 里对应的单张图。拼图格内的小字、型号、数字会糊，
凡是写进总结的具体参数（型号、重量、价格、比例、版本号）都必须回读单帧确认。

如果画面是**静止的文档或幻灯片**，on-screen 文字比语音识别可靠得多——以画面为准。
如果画面是**实拍**（人物、演示、对比图版），画面用来确认型号与数据，论据以讲述为准。

## 转写稿的坑

语音识别对人名、型号、专业名词几乎必错（例：「Mate XTS」被识别成「钱带/浅带」，
「长鑫」被识别成「长心/常心」）。规则：

- 凡涉及**型号、人名、公司名、数字**，一律回画面核对；核对不到就别写死。
- 拿不准的专有名词标「存疑」，或用音近写法加括号说明，不要假装确定。
- 明显的同音错字直接改（如「白菜价」被识别成「白色价」），但不要在没证据时改写原意。

## 怎么写这份总结

**先给一句话结论**，再展开。细节堆太多会把主线埋掉——用户最需要的是「这视频到底在说什么」。

推荐结构：

1. **一句话结论** —— 谁、在说什么事、结论是什么。不超过两行。
2. **主线展开** —— 按视频自己的逻辑分段，每段一个小标题。用视频里的原话和例子，别换成自己的抽象词。
3. **关键时间轴** —— \`| 时间 | 内容 |\` 表格，只放真正的转折点，十行以内。
4. **具体结论/数据** —— 涉及产品、价格、参数、判断时，给确切数值并注明出处（画面 or 讲述）。
5. **别误解的一点** —— 视频立场容易被误读的地方，用一句话点明边界。
6. **存疑与限制** —— 没核对上的专有名词、单方面说法、无法核实的前提。宁可写「未能确认」。

写作要求：

- 用中文，用大白话。用户说「看不懂」通常是因为术语堆砌和细节淹没主线，不是因为讲得不够多。
- 不添加视频里没有的信息，不替视频作者补充论证。
- 不写「这个视频介绍了……」这类空话，直接讲内容。
- 争议性内容要标明是视频作者的观点，不是事实；涉及双方对线时，说明这是单方面辩词。

## 收尾

在总结末尾用一行给出素材目录路径，方便用户自己核对或追问细节。
`;

export { VERSION };
