/**
 * Advisor Extension
 *
 * Registers an LLM-callable tool named `advisor` that allows the executor model
 * to consult a stronger "advisor" model for strategic guidance on complex decisions.
 *
 * Design based on Anthropic's advisor tool pattern:
 * https://claude.com/blog/the-advisor-strategy
 *
 * The advisor:
 * - Sees a curated transcript plus the executor's current system prompt
 * - Returns strategic guidance (plan, correction, or stop signal)
 * - Cannot call tools — only provides text advice
 * - Is invoked at the executor's discretion
 *
 * Commands:
 * - /advisor on [provider/model] — Enable advisor tool (persists to config)
 * - /advisor off                 — Disable advisor tool (persists to config)
 * - /advisor config [key=value]  — Show/edit advisor configuration
 * - /advisor                     — Show status or manually trigger consultation
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { complete, type Message, type TextContent, type ThinkingContent, type ToolCall } from "@mariozechner/pi-ai";
import { getAgentDir, getMarkdownTheme, keyHint, type ExtensionAPI, type SessionEntry, type ToolRenderResultOptions } from "@mariozechner/pi-coding-agent";
import { Box, Container, Markdown, Spacer, Text } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";

interface AdvisorConfig {
	enabled: boolean;
	provider: string;
	model: string;
	maxUsesPerRun: number;
	maxTokens: number;
}

interface AdvisorUsage {
	inputTokens: number;
	outputTokens: number;
	model: string;
}

type AdvisorStage = "initial" | "recovery" | "final-check";

interface AdvisorStageInfo {
	stage: AdvisorStage;
	reason: string;
}

interface AdvisorDetails {
	usage?: AdvisorUsage;
	callNumber: number;
	stage?: AdvisorStage;
	error?: string;
	message?: string;
}

interface RunToolEvent {
	toolName: string;
	summary: string;
	command?: string;
	isError: boolean;
	timestamp: number;
}

type ContentBlock = TextContent | ThinkingContent | ToolCall;

const DEFAULT_CONFIG: AdvisorConfig = {
	enabled: false,
	provider: "anthropic",
	model: "claude-opus-4-6",
	maxUsesPerRun: 3,
	maxTokens: 8192,
};

const MAX_ADVISOR_MESSAGES = 18;
const MAX_TEXT_LINES = 24;
const MAX_TEXT_CHARS = 1800;
const MAX_SYSTEM_PROMPT_CHARS = 12000;
const RECENT_TOOL_SUMMARY_COUNT = 8;

const ADVISOR_SYSTEM_PROMPT = `You are an expert advisor providing strategic guidance to a coding agent.

You are not the executor. You do not call tools, write user-facing prose, or continue the task directly. You only give guidance to the executor.

Your job is to provide:
- A clear plan when the executor is still choosing an approach
- A correction when the current trajectory is weak or stalled
- A final verification when implementation work appears done
- A stop signal if the current approach should be abandoned

Rules:
- Be concise, but complete enough to change the executor's next actions
- Use numbered steps when giving a plan
- Lead with the most important correction or risk
- Reference specific files, tool results, commands, or failure signals from the transcript when relevant
- If the executor is already on the right path, say so briefly and tell it the next concrete step
- If verification is incomplete, say exactly what evidence is still missing`;

const EXECUTOR_ADVISOR_GUIDANCE = `
Advisor timing guidance:
- On complex tasks, do a few exploratory reads first, then call advisor early before committing to an approach.
- If the task becomes difficult, direction feels uncertain, or attempts are not converging, call advisor again.
- After making file changes and seeing test or command output, call advisor for a final check before declaring completion.
- Typically use advisor around 2-3 times on a hard task, and skip it for simple tasks.

How to treat advisor guidance:
- Treat the advisor as a strategic reviewer whose plan should shape your next actions.
- If the advice conflicts with concrete evidence you've gathered, surface that conflict explicitly and resolve it instead of silently ignoring the advice.
- If you also use planner-style tools, consult advisor before committing to that plan.`;

function configPath(): string {
	return join(getAgentDir(), "advisor.json");
}

function loadConfig(): AdvisorConfig {
	const path = configPath();
	if (!existsSync(path)) return { ...DEFAULT_CONFIG };
	try {
		const raw = JSON.parse(readFileSync(path, "utf-8"));
		return {
			enabled: typeof raw.enabled === "boolean" ? raw.enabled : DEFAULT_CONFIG.enabled,
			provider: typeof raw.provider === "string" ? raw.provider : DEFAULT_CONFIG.provider,
			model: typeof raw.model === "string" ? raw.model : DEFAULT_CONFIG.model,
			maxUsesPerRun: typeof raw.maxUsesPerRun === "number" ? raw.maxUsesPerRun : DEFAULT_CONFIG.maxUsesPerRun,
			maxTokens: typeof raw.maxTokens === "number" ? raw.maxTokens : DEFAULT_CONFIG.maxTokens,
		};
	} catch {
		return { ...DEFAULT_CONFIG };
	}
}

function saveConfig(config: AdvisorConfig): void {
	const path = configPath();
	const dir = dirname(path);
	if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
	writeFileSync(path, JSON.stringify(config, null, 2), "utf-8");
}

function formatTokens(count: number): string {
	if (count < 1000) return count.toString();
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1000000) return `${Math.round(count / 1000)}k`;
	return `${(count / 1000000).toFixed(1)}M`;
}

function stageLabel(stage: AdvisorStage): string {
	switch (stage) {
		case "initial":
			return "initial";
		case "recovery":
			return "recovery";
		case "final-check":
			return "final check";
	}
}

function stageDirective(stage: AdvisorStage): string {
	switch (stage) {
		case "initial":
			return "Give the shortest correct plan, the main risk to avoid, and the first concrete actions the executor should take.";
		case "recovery":
			return "Diagnose why the current trajectory is weak, say what to stop doing if needed, and provide a corrected path.";
		case "final-check":
			return "Verify whether the task is actually done. Call out missing validation or unmet requirements explicitly.";
	}
}

function squeezeWhitespace(text: string): string {
	return text.replace(/\s+/g, " ").trim();
}

function clampText(text: string, maxLines: number = MAX_TEXT_LINES, maxChars: number = MAX_TEXT_CHARS): string {
	const normalized = text.trim();
	if (!normalized) return normalized;

	const lines = normalized.split("\n");
	let truncated = false;
	let next = lines.slice(0, maxLines).join("\n");
	if (lines.length > maxLines) truncated = true;
	if (next.length > maxChars) {
		next = `${next.slice(0, maxChars).trimEnd()}…`;
		truncated = true;
	}
	if (!truncated) return next;
	return `${next}\n[truncated for advisor context]`;
}

function extractPrimaryText(content: unknown): string {
	if (!Array.isArray(content)) return "";
	return content
		.filter((block): block is { type: string; text: string } => Boolean(block) && typeof block === "object" && (block as { type?: string }).type === "text")
		.map((block) => block.text)
		.join("\n")
		.trim();
}

function extractBashExitCode(text: string): number | undefined {
	const match = text.match(/exit code:\s*(\d+)/i);
	if (!match) return undefined;
	const code = Number.parseInt(match[1], 10);
	return Number.isNaN(code) ? undefined : code;
}

function isVerificationCommand(command?: string): boolean {
	if (!command) return false;
	return /\b(test|tests|jest|vitest|pytest|rspec|cargo test|go test|npm run test|npm test|pnpm test|pnpm run test|yarn test|check|lint|typecheck|tsc|build)\b/i.test(command);
}

function summarizeToolExecution(toolName: string, args: any, result: any, isError: boolean): RunToolEvent {
	const text = extractPrimaryText(result?.content);
	const oneLine = squeezeWhitespace(text).slice(0, 140);

	switch (toolName) {
		case "read": {
			const path = typeof args?.path === "string" ? args.path : "(unknown path)";
			return { toolName, summary: `read ${path}`, isError, timestamp: Date.now() };
		}
		case "edit":
		case "write": {
			const path = typeof args?.path === "string" ? args.path : "(unknown path)";
			return { toolName, summary: `${toolName} ${path}`, isError, timestamp: Date.now() };
		}
		case "bash": {
			const command = typeof args?.command === "string" ? squeezeWhitespace(args.command).slice(0, 140) : undefined;
			const exitCode = extractBashExitCode(text);
			const suffix = exitCode !== undefined ? ` (exit ${exitCode})` : isError ? " (error)" : "";
			return {
				toolName,
				summary: `$ ${command ?? "(unknown command)"}${suffix}`,
				command,
				isError: isError || (exitCode !== undefined && exitCode !== 0),
				timestamp: Date.now(),
			};
		}
		default:
			return {
				toolName,
				summary: oneLine ? `${toolName}: ${oneLine}` : toolName,
				isError,
				timestamp: Date.now(),
			};
	}
}

function detectStage(events: RunToolEvent[], advisorCallsThisRun: number): AdvisorStageInfo {
	const hasMutation = events.some((event) => event.toolName === "edit" || event.toolName === "write");
	const hasVerification = events.some((event) => event.toolName === "bash" && isVerificationCommand(event.command));
	const recentFailure = [...events].reverse().find((event) => event.isError);
	const explorationCount = events.filter((event) => event.toolName === "read" || event.toolName === "bash").length;

	if (hasMutation && hasVerification) {
		return {
			stage: "final-check",
			reason: "Implementation changes exist and verification output is already in the transcript.",
		};
	}

	if (recentFailure) {
		return {
			stage: "recovery",
			reason: `Recent failure signal: ${recentFailure.summary}`,
		};
	}

	if (hasMutation && advisorCallsThisRun > 1) {
		return {
			stage: "recovery",
			reason: "Implementation has started and the executor is checking course again before finishing.",
		};
	}

	if (!hasMutation && explorationCount >= 2) {
		return {
			stage: "initial",
			reason: "Exploratory reads or commands have happened, but the executor has not committed to file changes yet.",
		};
	}

	if (hasMutation) {
		return {
			stage: "recovery",
			reason: "Implementation is in progress, but there is not enough verification evidence yet for a final check.",
		};
	}

	return {
		stage: "initial",
		reason: "The executor is still in the early orientation phase.",
	};
}

function summarizeUserContent(content: Message["content"]): Message["content"] {
	if (typeof content === "string") return clampText(content, 40, 2800);
	if (!Array.isArray(content)) return content;
	return content.map((block) => {
		if (block.type !== "text") return block;
		return { ...block, text: clampText(block.text, 40, 2800) };
	});
}

function summarizeAssistantContent(content: ContentBlock[]): ContentBlock[] {
	return content
		.filter((block) => block.type !== "thinking")
		.filter((block) => !(block.type === "toolCall" && block.name === "advisor"))
		.map((block) => {
			if (block.type !== "text") return block;
			return { ...block, text: clampText(block.text) };
		});
}

function summarizeToolResultContent(toolName: string, content: unknown): Array<{ type: "text"; text: string } | { type: string; [key: string]: unknown }> {
	if (!Array.isArray(content)) return [];
	return content.map((block) => {
		if (!block || typeof block !== "object" || (block as { type?: string }).type !== "text") {
			return block as { type: string; [key: string]: unknown };
		}
		const textBlock = block as { type: "text"; text: string };
		return {
			...textBlock,
			text: clampText(textBlock.text, toolName === "bash" ? 28 : MAX_TEXT_LINES, toolName === "bash" ? 2200 : MAX_TEXT_CHARS),
		};
	});
}

function buildAdvisorMessages(branch: SessionEntry[], stageInfo: AdvisorStageInfo, recentToolActivity: string): Message[] {
	const transcript: Message[] = [];

	for (const entry of branch) {
		if (entry.type !== "message" || !("message" in entry)) continue;
		const msg = entry.message;
		if (!msg || !("role" in msg)) continue;

		if (msg.role === "user") {
			transcript.push({ ...msg, content: summarizeUserContent(msg.content) } as Message);
			continue;
		}

		if (msg.role === "assistant") {
			const content = Array.isArray(msg.content) ? summarizeAssistantContent(msg.content as ContentBlock[]) : [];
			if (content.length > 0) transcript.push({ ...msg, content } as Message);
			continue;
		}

		if (msg.role === "toolResult") {
			if (msg.toolName === "advisor") continue;
			const content = summarizeToolResultContent(msg.toolName, msg.content);
			if (content.length > 0) transcript.push({ ...msg, content } as Message);
		}
	}

	if (transcript.length === 0) return [];

	const contextMessage: Message = {
		role: "user",
		content: [
			`Current advisory stage: ${stageInfo.stage}`,
			`Why this stage: ${stageInfo.reason}`,
			recentToolActivity ? `Recent tool activity:\n${recentToolActivity}` : "Recent tool activity: none yet",
		].join("\n\n"),
		timestamp: Date.now(),
	};

	if (transcript.length <= MAX_ADVISOR_MESSAGES) {
		return [contextMessage, ...transcript];
	}

	const keepFirst = 2;
	const keepLast = MAX_ADVISOR_MESSAGES - keepFirst - 1;
	const omitted = transcript.length - keepFirst - keepLast;
	const omittedMessage: Message = {
		role: "user",
		content: `[${omitted} earlier transcript messages omitted. Focus on the retained task framing and the most recent evidence.]`,
		timestamp: Date.now(),
	};

	return [contextMessage, ...transcript.slice(0, keepFirst), omittedMessage, ...transcript.slice(-keepLast)];
}

function buildActiveToolsSummary(pi: ExtensionAPI): string {
	const activeToolNames = new Set(pi.getActiveTools().filter((name) => name !== "advisor"));
	const activeTools = pi
		.getAllTools()
		.filter((tool) => activeToolNames.has(tool.name))
		.sort((a, b) => a.name.localeCompare(b.name));

	if (activeTools.length === 0) return "- No active tools recorded";

	return activeTools
		.map((tool) => `- ${tool.name}: ${squeezeWhitespace(tool.description).slice(0, 160)}`)
		.join("\n");
}

function buildRecentToolActivity(events: RunToolEvent[]): string {
	if (events.length === 0) return "";
	return events
		.slice(-RECENT_TOOL_SUMMARY_COUNT)
		.map((event) => `- ${event.summary}`)
		.join("\n");
}

function buildAdvisorPrompt(executorSystemPrompt: string, activeToolsSummary: string, stageInfo: AdvisorStageInfo): string {
	const trimmedSystemPrompt = executorSystemPrompt.trim();
	const boundedSystemPrompt = trimmedSystemPrompt.length > MAX_SYSTEM_PROMPT_CHARS
		? `${trimmedSystemPrompt.slice(0, MAX_SYSTEM_PROMPT_CHARS).trimEnd()}\n[executor system prompt truncated for advisor context]`
		: trimmedSystemPrompt;

	return `${ADVISOR_SYSTEM_PROMPT}

Current stage: ${stageInfo.stage}
Stage objective: ${stageDirective(stageInfo.stage)}
Why this stage: ${stageInfo.reason}

Executor system prompt:
<<<SYSTEM_PROMPT
${boundedSystemPrompt}
SYSTEM_PROMPT>>>

Active tools available to the executor:
${activeToolsSummary}`;
}

function buildPreview(text: string, lines: number): { preview: string; truncated: boolean } {
	const split = text.split("\n");
	if (split.length <= lines) return { preview: text, truncated: false };
	return { preview: `${split.slice(0, lines).join("\n")}\n…`, truncated: true };
}

export default function advisorExtension(pi: ExtensionAPI) {
	let config = loadConfig();
	let usesThisRun = 0;
	let runToolEvents: RunToolEvent[] = [];
	const toolArgsById = new Map<string, any>();

	pi.on("before_agent_start", async (event) => {
		config = loadConfig();
		if (!config.enabled) return;
		return {
			systemPrompt: `${event.systemPrompt}\n\n${EXECUTOR_ADVISOR_GUIDANCE}`,
		};
	});

	pi.on("agent_start", async () => {
		usesThisRun = 0;
		runToolEvents = [];
		toolArgsById.clear();
	});

	pi.on("tool_execution_start", async (event) => {
		toolArgsById.set(event.toolCallId, event.args);
	});

	pi.on("tool_execution_end", async (event) => {
		if (event.toolName === "advisor") return;
		const args = toolArgsById.get(event.toolCallId);
		toolArgsById.delete(event.toolCallId);
		runToolEvents.push(summarizeToolExecution(event.toolName, args, event.result, event.isError));
	});

	pi.on("session_start", async () => {
		config = loadConfig();
		updateToolRegistration();
	});

	function updateToolRegistration() {
		const activeTools = pi.getActiveTools();
		if (config.enabled) {
			if (!activeTools.includes("advisor")) {
				pi.setActiveTools([...activeTools, "advisor"]);
			}
			return;
		}
		if (activeTools.includes("advisor")) {
			pi.setActiveTools(activeTools.filter((tool) => tool !== "advisor"));
		}
	}

	pi.registerTool({
		name: "advisor",
		label: "Consult advisor",
		description: `Consult a stronger model for strategic guidance on complex decisions.
The advisor sees curated conversation context, the executor's system prompt, and recent tool evidence.
The advisor cannot call tools — it only provides text advice for the executor.`,
		promptSnippet: "advisor: consult a stronger model for strategic guidance on complex tasks",
		promptGuidelines: [
			"For complex tasks, call advisor after a few exploratory reads, before committing to an approach",
			"If the task becomes difficult or direction feels uncertain, call advisor again to correct course",
			"After making file changes and seeing verification output, call advisor for a final check before declaring completion",
			"Treat advisor guidance as strategic direction; if it conflicts with evidence, surface the conflict explicitly",
		],
		parameters: Type.Object({}),

		async execute(_toolCallId, _params, signal, _onUpdate, ctx) {
			config = loadConfig();

			if (usesThisRun >= config.maxUsesPerRun) {
				return {
					content: [{ type: "text", text: `Advisor usage limit reached (${config.maxUsesPerRun} per run). Continue without advisor guidance.` }],
					details: { error: "max_uses_exceeded", callNumber: usesThisRun } as AdvisorDetails,
				};
			}
			usesThisRun++;

			const model = ctx.modelRegistry.find(config.provider, config.model);
			if (!model) {
				return {
					content: [{ type: "text", text: `Advisor model ${config.provider}/${config.model} not found. Continue without advice.` }],
					details: { error: "model_not_found", callNumber: usesThisRun } as AdvisorDetails,
				};
			}

			const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
			if (!auth.ok || !auth.apiKey) {
				const errorMsg = auth.ok ? "No API key" : auth.error;
				return {
					content: [{ type: "text", text: `${errorMsg} for advisor model ${config.provider}/${config.model}. Continue without advice.` }],
					details: { error: "no_api_key", callNumber: usesThisRun } as AdvisorDetails,
				};
			}

			const stageInfo = detectStage(runToolEvents, usesThisRun);
			const recentToolActivity = buildRecentToolActivity(runToolEvents);
			const branch = ctx.sessionManager.getBranch();
			const advisorMessages = buildAdvisorMessages(branch, stageInfo, recentToolActivity);
			if (advisorMessages.length === 0) {
				return {
					content: [{ type: "text", text: "No conversation context available for advisor. Continue without advice." }],
					details: { error: "no_context", callNumber: usesThisRun, stage: stageInfo.stage } as AdvisorDetails,
				};
			}

			const executorSystemPrompt = ctx.getSystemPrompt();
			const advisorPrompt = buildAdvisorPrompt(executorSystemPrompt, buildActiveToolsSummary(pi), stageInfo);

			try {
				const response = await complete(
					model,
					{
						systemPrompt: advisorPrompt,
						messages: advisorMessages,
					},
					{
						apiKey: auth.apiKey,
						headers: auth.headers,
						maxTokens: config.maxTokens,
						signal,
					},
				);

				const adviceText = response.content
					.filter((block): block is TextContent => block.type === "text")
					.map((block) => block.text)
					.join("\n")
					.trim();

				const usage: AdvisorUsage = {
					inputTokens: response.usage?.input ?? 0,
					outputTokens: response.usage?.output ?? 0,
					model: config.model,
				};

				pi.appendEntry("advisor-usage", usage);

				return {
					content: [{ type: "text", text: adviceText || "(Advisor returned empty response)" }],
					details: { usage, callNumber: usesThisRun, stage: stageInfo.stage } as AdvisorDetails,
				};
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				return {
					content: [{ type: "text", text: `Advisor call failed: ${msg}. Continue without advice.` }],
					details: { error: "execution_failed", message: msg, callNumber: usesThisRun, stage: stageInfo.stage } as AdvisorDetails,
				};
			}
		},

		renderCall() {
			return new Container();
		},

		renderResult(result, options: ToolRenderResultOptions, theme) {
			const details = result.details as AdvisorDetails | undefined;
			const text = result.content[0]?.type === "text" ? result.content[0].text : "(no advice)";

			if (options.isPartial) {
				return new Text(theme.fg("muted", "Advisor…"), 0, 0);
			}

			if (details?.error) {
				return new Text(theme.fg("error", "Advisor unavailable: ") + theme.fg("dim", text), 0, 0);
			}

			const box = new Box(1, 1, (content) => theme.bg("customMessageBg", content));
			let header = theme.fg("toolTitle", theme.bold("Advisor"));
			if (details?.stage) header += " " + theme.fg("muted", stageLabel(details.stage));
			if (details?.callNumber) header += theme.fg("dim", ` #${details.callNumber}/${config.maxUsesPerRun}`);
			box.addChild(new Text(header, 0, 0));
			box.addChild(new Spacer(1));

			if (options.expanded) {
				box.addChild(new Markdown(text, 0, 0, getMarkdownTheme()));
			} else {
				const preview = buildPreview(text, 6);
				box.addChild(new Markdown(preview.preview, 0, 0, getMarkdownTheme()));
				if (preview.truncated) {
					box.addChild(new Spacer(1));
					box.addChild(new Text(theme.fg("muted", keyHint("app.tools.expand", "to expand")), 0, 0));
				}
			}

			if (details?.usage) {
				box.addChild(new Spacer(1));
				box.addChild(
					new Text(
						theme.fg("dim", `↑${formatTokens(details.usage.inputTokens)} ↓${formatTokens(details.usage.outputTokens)} ${details.usage.model}`),
						0,
						0,
					),
				);
			}

			return box;
		},
	});

	pi.registerCommand("advisor", {
		description: "Manage advisor tool: on, off, config, ask",
		handler: async (args, ctx) => {
			const parts = args.trim().split(/\s+/);
			const subcommand = parts[0]?.toLowerCase() || "";
			const rest = parts.slice(1).join(" ");

			switch (subcommand) {
				case "on": {
					if (rest) {
						const modelParts = rest.split("/");
						if (modelParts.length === 2) {
							config.provider = modelParts[0];
							config.model = modelParts[1];
						} else {
							ctx.ui.notify("Invalid format. Use: /advisor on provider/model (e.g., anthropic/claude-opus-4-6)", "warning");
							return;
						}
					}

					const model = ctx.modelRegistry.find(config.provider, config.model);
					if (!model) {
						ctx.ui.notify(`Model ${config.provider}/${config.model} not found`, "error");
						return;
					}

					config.enabled = true;
					saveConfig(config);
					updateToolRegistration();
					ctx.ui.notify(`Advisor enabled: ${config.provider}/${config.model}`, "info");
					break;
				}

				case "off": {
					config.enabled = false;
					saveConfig(config);
					updateToolRegistration();
					ctx.ui.notify("Advisor disabled", "info");
					break;
				}

				case "config": {
					if (!rest) {
						const status = config.enabled ? ctx.ui.theme.fg("success", "enabled") : ctx.ui.theme.fg("dim", "disabled");
						const lines = [
							"Advisor Configuration",
							"",
							`  Status:       ${status}`,
							`  Provider:     ${config.provider}`,
							`  Model:        ${config.model}`,
							`  Max uses/run: ${config.maxUsesPerRun}`,
							`  Max tokens:   ${config.maxTokens}`,
							"",
							"Usage:",
							"  /advisor on [provider/model]  Enable advisor",
							"  /advisor off                  Disable advisor",
							"  /advisor config key=value     Set config value",
							"  /advisor ask                  Trigger consultation",
							"",
							"Config keys: provider, model, maxUsesPerRun, maxTokens",
						];
						ctx.ui.notify(lines.join("\n"), "info");
						return;
					}

					const match = rest.match(/^(\w+)=(.+)$/);
					if (!match) {
						ctx.ui.notify("Invalid format. Use: /advisor config key=value", "warning");
						return;
					}

					const [, key, value] = match;
					switch (key) {
						case "provider":
							config.provider = value;
							break;
						case "model":
							config.model = value;
							break;
						case "maxUsesPerRun": {
							const num = Number.parseInt(value, 10);
							if (Number.isNaN(num) || num < 1) {
								ctx.ui.notify("maxUsesPerRun must be a positive integer", "warning");
								return;
							}
							config.maxUsesPerRun = num;
							break;
						}
						case "maxTokens": {
							const num = Number.parseInt(value, 10);
							if (Number.isNaN(num) || num < 100) {
								ctx.ui.notify("maxTokens must be at least 100", "warning");
								return;
							}
							config.maxTokens = num;
							break;
						}
						default:
							ctx.ui.notify("Unknown config key. Valid keys: provider, model, maxUsesPerRun, maxTokens", "warning");
							return;
					}

					saveConfig(config);
					ctx.ui.notify(`Set ${key}=${value}`, "info");
					break;
				}

				case "ask": {
					if (!config.enabled) {
						ctx.ui.notify("Advisor is disabled. Use /advisor on to enable.", "warning");
						return;
					}
					const prompt = "Consult the advisor now using the current stage and recent evidence before proceeding.";
					if (ctx.isIdle()) {
						pi.sendUserMessage(prompt);
					} else {
						pi.sendUserMessage(prompt, { deliverAs: "steer" });
					}
					break;
				}

				default: {
					const status = config.enabled ? ctx.ui.theme.fg("success", "enabled") : ctx.ui.theme.fg("dim", "disabled");
					const lines = [
						`Advisor: ${status}`,
						`Model: ${config.provider}/${config.model}`,
						"",
						"Commands:",
						"  /advisor on [provider/model]  Enable advisor",
						"  /advisor off                  Disable advisor",
						"  /advisor config               Show full configuration",
						"  /advisor ask                  Trigger consultation",
					];
					ctx.ui.notify(lines.join("\n"), "info");
				}
			}
		},
	});
}
