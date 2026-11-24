#!/usr/bin/env tsx

import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { basename, dirname, extname, isAbsolute, join, parse as parsePath, relative, resolve, sep } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { parse, stringify } from "yaml";
import { cancel, confirm, intro, isCancel, log, outro, select } from "@clack/prompts";

type PublishType = "note" | "jotting";
type PublishMeta = Record<string, unknown> & {
	title: string;
	timestamp: Date | string;
	type: PublishType;
	locale: "zh-cn" | "en" | "ja";
	slug: string;
};

type SourceArticle = {
	path: string;
	meta: PublishMeta;
	body: string;
};

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const siteRoot = resolve(scriptDirectory, "..");
const vaultRoot = resolve(process.env.OBSIDIAN_VAULT || ".");
const publishRoot = join(vaultRoot, "Publish");
const contentRoot = join(siteRoot, "src", "content");
const siteSettings = JSON.parse(readFileSync(join(siteRoot, "site.config.json"), "utf8"));
const siteBase = String(siteSettings.base || "/").replace(/\/+$/, "");
const remote = process.env.OBSIDIAN_BLOG_REMOTE || "origin";
const branch = process.env.OBSIDIAN_BLOG_BRANCH || "main";
const allowedLocales = new Set(["zh-cn", "en", "ja"]);
const assetExtensions = new Set([".avif", ".gif", ".jpeg", ".jpg", ".pdf", ".png", ".svg", ".webp"]);
const fromObsidian = process.argv.includes("--obsidian");
const push = fromObsidian && process.argv.includes("--push");
const dryRun = process.argv.includes("--dry-run");

function isWithin(directory: string, path: string): boolean {
	const rest = relative(directory, path);
	return rest !== "" && rest !== ".." && !rest.startsWith(`..${sep}`) && !isAbsolute(rest);
}

function markdownFiles(directory: string): string[] {
	if (!existsSync(directory)) return [];

	return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
		const path = join(directory, entry.name);
		if (entry.isDirectory()) return markdownFiles(path);
		return entry.isFile() && extname(entry.name).toLowerCase() === ".md" && !entry.name.startsWith("_") ? [path] : [];
	});
}

function readArticle(path: string): SourceArticle {
	const source = readFileSync(path, "utf8").replace(/^\uFEFF/, "");
	const match = source.match(/^---\s*\r?\n([\s\S]*?)\r?\n---\s*(?:\r?\n|$)([\s\S]*)$/);
	if (!match) throw new Error("缺少 YAML frontmatter");

	const meta = parse(match[1]) as PublishMeta;
	if (!meta || typeof meta !== "object") throw new Error("frontmatter 不是有效对象");
	if (!meta.title || typeof meta.title !== "string") throw new Error("title 必须是非空字符串");
	if (!meta.timestamp || Number.isNaN(new Date(meta.timestamp).getTime())) throw new Error("timestamp 缺失或日期格式无效");
	if (meta.type !== "note" && meta.type !== "jotting") throw new Error("type 必须是 note 或 jotting");
	if (!allowedLocales.has(meta.locale)) throw new Error("locale 必须是 zh-cn、en 或 ja");
	if (typeof meta.slug !== "string" || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(meta.slug)) throw new Error("slug 只能包含小写英文字母、数字和连接号");

	return { path, meta, body: match[2] };
}

function loadArticles(): SourceArticle[] {
	const articles: SourceArticle[] = [];
	for (const path of markdownFiles(publishRoot)) {
		try {
			articles.push(readArticle(path));
		} catch (error) {
			log.warn(`${relative(vaultRoot, path)}：${(error as Error).message}`);
		}
	}

	const destinations = new Set<string>();
	for (const article of articles) {
		const destination = `${article.meta.type}/${article.meta.locale}/${article.meta.slug}`;
		if (destinations.has(destination)) throw new Error(`存在重复发布目标：${destination}`);
		destinations.add(destination);
	}
	return articles;
}

function publicArticleUrl(article: SourceArticle): string {
	const locale = article.meta.locale === "zh-cn" ? "" : `/${article.meta.locale}`;
	return `${siteBase}${locale}/${article.meta.type}/${article.meta.slug}`;
}

function filesRecursively(directory: string): string[] {
	if (!existsSync(directory)) return [];
	return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
		const path = join(directory, entry.name);
		return entry.isDirectory() ? filesRecursively(path) : entry.isFile() ? [path] : [];
	});
}

function findAttachment(article: SourceArticle, reference: string): string | undefined {
	const clean = decodeURIComponent(reference.split("#")[0]).replace(/\\/g, "/");
	const articleDirectory = dirname(article.path);
	const candidates = [resolve(articleDirectory, clean)];
	if (!fromObsidian) candidates.push(resolve(vaultRoot, clean));
	const exact = candidates.find(path => {
		if (fromObsidian && !isWithin(articleDirectory, path)) {
			throw new Error(`附件必须位于文章目录内：${reference}`);
		}
		if (!existsSync(path) || !statSync(path).isFile()) return false;
		if (fromObsidian && !isWithin(realpathSync(articleDirectory), realpathSync(path))) {
			throw new Error(`附件链接指向文章目录之外：${reference}`);
		}
		return true;
	});
	if (exact) return exact;

	// Obsidian often stores ![[image.png]] even when the file lives in ./assets.
	const matches = filesRecursively(articleDirectory).filter(path => basename(path).toLowerCase() === basename(clean).toLowerCase());
	if (matches.length > 1) throw new Error(`附件名称不唯一：${reference}`);
	return matches[0];
}

function normalizedAssetName(filename: string): string {
	const parsed = parsePath(filename);
	const pasted = parsed.name.match(/^Pasted image (\d{8})(\d{6})$/i);
	return pasted ? `image-${pasted[1]}-${pasted[2]}${parsed.ext.toLowerCase()}` : filename;
}

function destinationAssetPath(article: SourceArticle, source: string): string {
	const articleDirectory = dirname(article.path);
	const sourceRelative = relative(articleDirectory, source);
	const parts = sourceRelative.split(sep);
	const insideAssets = parts[0]?.toLowerCase() === "assets";
	const destinationParts = insideAssets ? parts : ["assets", basename(source)];
	destinationParts[destinationParts.length - 1] = normalizedAssetName(destinationParts.at(-1)!);
	return destinationParts.join("/");
}

function transform(article: SourceArticle, articles: SourceArticle[]): { body: string; assets: Map<string, string>; warnings: string[] } {
	let body = article.body;
	const assets = new Map<string, string>();
	const warnings: string[] = [];
	const registerAsset = (source: string): string => {
		const destination = destinationAssetPath(article, source);
		const existing = assets.get(destination);
		if (existing && resolve(existing) !== resolve(source)) throw new Error(`附件发布路径冲突：${destination}`);
		assets.set(destination, source);
		return destination;
	};

	body = body.replace(/!\[([^\]]*)\]\((?!https?:\/\/|data:|\/)([^)]+)\)/g, (whole, alt: string, reference: string) => {
		const source = findAttachment(article, reference.trim());
		if (!source) {
			if (fromObsidian) throw new Error(`找不到 Markdown 图片：${reference}`);
			warnings.push(`无法找到 Markdown 图片：${reference}`);
			return whole;
		}
		const destination = registerAsset(source);
		return `![${alt}](./${destination})`;
	});

	body = body.replace(/!\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_, reference: string, label?: string) => {
		const source = findAttachment(article, reference.trim());
		if (!source || !assetExtensions.has(extname(source).toLowerCase())) {
			if (fromObsidian) throw new Error(`找不到支持的图片附件：${reference}`);
			warnings.push(`无法找到图片附件：${reference}`);
			return `![${label || basename(reference)}](${reference})`;
		}
		const destination = registerAsset(source);
		return `![${label || basename(destination)}](./${destination})`;
	});

	body = body.replace(/(?<!!)\[\[([^\]|#]+)(?:#[^\]|]+)?(?:\|([^\]]+))?\]\]/g, (_, target: string, label?: string) => {
		const normalized = target.trim();
		const destination = articles.find(candidate => candidate.meta.slug === normalized || candidate.meta.title === normalized || basename(candidate.path, ".md") === normalized);
		const text = label?.trim() || destination?.meta.title || normalized;
		if (!destination) {
			warnings.push(`无法解析 Wiki 链接：${normalized}`);
			return text;
		}
		return `[${text}](${publicArticleUrl(destination)})`;
	});

	const sourceAssets = filesRecursively(join(dirname(article.path), "assets"))
		.filter(path => assetExtensions.has(extname(path).toLowerCase()));
	const referenced = new Set(Array.from(assets.values(), path => resolve(path).toLowerCase()));
	for (const source of sourceAssets) {
		if (!referenced.has(resolve(source).toLowerCase())) warnings.push(`未引用附件（不会发布）：${relative(dirname(article.path), source).split(sep).join("/")}`);
	}

	return { body, assets, warnings };
}

function siteFrontmatter(article: SourceArticle): Record<string, unknown> {
	const allowed = article.meta.type === "note"
		? ["title", "timestamp", "series", "tags", "description", "sensitive", "toc", "top", "draft"]
		: ["title", "timestamp", "tags", "description", "sensitive", "top", "draft"];

	return Object.fromEntries(allowed.filter(key => article.meta[key] !== undefined && article.meta[key] !== null && article.meta[key] !== "").map(key => [key, article.meta[key]]));
}

function runAstro(name: string): void {
	const require = createRequire(import.meta.url);
	const cli = join(dirname(require.resolve("astro/package.json")), "astro.js");
	log.step(`Astro ${name}`);
	const result = spawnSync(process.execPath, [cli, name], {
		cwd: siteRoot,
		stdio: "inherit",
		env: { ...process.env, ASTRO_TELEMETRY_DISABLED: "1" }
	});
	if (result.error) throw result.error;
	if (result.status !== 0) throw new Error(`Astro ${name} 失败`);
}

function git(args: string[], capture = false): string {
	const result = spawnSync("git", ["--literal-pathspecs", ...args], {
		cwd: siteRoot,
		encoding: "utf8",
		stdio: capture ? ["ignore", "pipe", "inherit"] : "inherit",
		env: { ...process.env, GIT_TERMINAL_PROMPT: "0" }
	});
	if (result.error) throw result.error;
	if (result.status !== 0) throw new Error(`Git ${args[0]} 失败`);
	return result.stdout?.trim() ?? "";
}

function checkPublishTarget(): void {
	const root = git(["rev-parse", "--show-toplevel"], true);
	if (realpathSync(root) !== realpathSync(siteRoot)) throw new Error("博客目录必须是 Git 仓库根目录");
	if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(remote)) throw new Error("Git 远端名无效");
	git(["check-ref-format", "refs/heads/" + branch], true);
	if (git(["branch", "--show-current"], true) !== branch) {
		throw new Error("请先切换到博客部署分支 " + branch);
	}
	const urls = git(["remote", "get-url", "--push", "--all", remote], true);
	if (!urls || /[\r\n]/.test(urls)) throw new Error("请为博客部署远端配置唯一的推送地址");
}

function commitAndPush(article: SourceArticle, paths: string[]): void {
	checkPublishTarget();
	const files = paths.map(path => relative(siteRoot, path).split(sep).join("/"));
	log.step("提交本次同步的文件");
	git(["add", "--", ...files]);
	if (git(["diff", "--cached", "--name-only", "--", ...files], true)) {
		git(["commit", "--only", "-m", `Publish ${article.meta.slug} from Obsidian`, "--", ...files]);
	} else {
		log.info("本次同步没有产生新的提交");
	}
	log.step("推送到 GitHub");
	const ref = "refs/heads/" + branch;
	git(["push", remote, ref + ":" + ref]);
}

async function main() {
	intro("Obsidian → Obsidian2Blog");
	if (!process.env.OBSIDIAN_VAULT) throw new Error("请通过插件运行，或设置 OBSIDIAN_VAULT 指向笔记仓库");
	if (!existsSync(publishRoot)) throw new Error(`发布目录不存在：${publishRoot}`);

	const articles = loadArticles();
	if (!articles.length) throw new Error(`没有找到可发布文章，请先在 ${publishRoot} 中创建文章`);

	const argument = process.argv.slice(2).find(value => !value.startsWith("--"));
	if (fromObsidian && (!argument || !isAbsolute(argument))) throw new Error("请指定笔记的绝对路径");
	let article: SourceArticle | undefined;
	if (argument) {
		const requested = resolve(argument);
		article = articles.find(item => resolve(item.path) === requested || (!fromObsidian && item.meta.slug === argument));
		if (!article) throw new Error(`找不到文章：${argument}`);
	} else {
		const choice = await select({
			message: "选择要同步到网站的文章",
			options: articles.map(item => ({
				value: item.path,
				label: item.meta.title,
				hint: `${item.meta.type}/${item.meta.locale}/${item.meta.slug}${item.meta.draft ? " · draft" : ""}`
			}))
		});
		if (isCancel(choice)) return cancel("已取消发布");
		article = articles.find(item => item.path === choice);
	}

	if (!article) throw new Error("没有选择文章");
	if (fromObsidian && article.meta.draft !== false) throw new Error("请先在笔记属性中设置 draft: false");
	if (push) checkPublishTarget();

	log.step("转换笔记和图片");
	const converted = transform(article, fromObsidian ? articles.filter(item => item.meta.draft === false) : articles);
	converted.warnings.forEach(warning => log.warn(warning));

	const destinationDirectory = join(contentRoot, article.meta.type, article.meta.locale, article.meta.slug);
	const destinationMarkdown = join(destinationDirectory, "index.md");
	if (existsSync(destinationMarkdown) && !fromObsidian && !process.argv.includes("--force") && !dryRun) {
		const overwrite = await confirm({ message: `${relative(siteRoot, destinationMarkdown)} 已存在，是否覆盖？`, initialValue: false });
		if (isCancel(overwrite) || !overwrite) return cancel("未覆盖现有文章");
	}

	if (dryRun) {
		log.info(`将写入：${destinationMarkdown}`);
		converted.assets.forEach((source, path) => log.info(`将复制：${source} → ${join(destinationDirectory, path)}`));
		return outro("检查完成，未写入文件");
	}

	mkdirSync(destinationDirectory, { recursive: true });
	const output = `---\n${stringify(siteFrontmatter(article), { lineWidth: 0 }).trimEnd()}\n---\n\n${converted.body.replace(/^\s+/, "")}`;
	writeFileSync(destinationMarkdown, output, "utf8");
	converted.assets.forEach((source, path) => {
		const destination = join(destinationDirectory, path);
		mkdirSync(dirname(destination), { recursive: true });
		copyFileSync(source, destination);
	});
	log.success(`已同步到 ${relative(siteRoot, destinationMarkdown).split(sep).join("/")}`);

	if (fromObsidian || !process.argv.includes("--skip-check")) {
		runAstro("check");
		runAstro("build");
	}

	if (push) {
		commitAndPush(article, [destinationMarkdown, ...Array.from(converted.assets.keys(), path => join(destinationDirectory, path))]);
		return outro("GitHub 已接收推送，可在 Actions 查看部署进度");
	}
	outro("发布文件已准备好；请检查 Git diff 后自行提交和推送");
}

main().catch(error => {
	log.error((error as Error).message);
	process.exitCode = 1;
});
