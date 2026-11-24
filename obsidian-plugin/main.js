const { FileSystemAdapter, Modal, Notice, Plugin, PluginSettingTab, Setting, TFile, TFolder, getFrontMatterInfo, moment, parseYaml, stringifyYaml } = require("obsidian");
const { spawn } = require("node:child_process");
const { existsSync } = require("node:fs");
const { readFile, readdir } = require("node:fs/promises");
const { isAbsolute, join } = require("node:path");
const { stripVTControlCharacters } = require("node:util");

const DEFAULTS = { blogPath: "", node: "node", remote: "origin", branch: "main" };

class BlogSettings extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display() {
    this.containerEl.empty();
    const fields = [
      ["blogPath", "本地博客目录", "包含 package.json 和 scripts/publish.ts 的绝对路径"],
      ["node", "Node.js 可执行文件", "默认从 PATH 查找 node，也可填写绝对路径"],
      ["remote", "Git 远端", "默认 origin"],
      ["branch", "部署分支", "与 GitHub Actions 的触发分支一致，默认 main"]
    ];
    for (const [key, label, hint] of fields) {
      new Setting(this.containerEl).setName(label).setDesc(hint).addText(text => {
        text.setValue(this.plugin.settings[key]).onChange(async value => {
          this.plugin.settings[key] = value.trim() || DEFAULTS[key];
          await this.plugin.saveData(this.plugin.settings);
        });
      });
    }
  }
}

const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const WINDOWS_DEVICE = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/;

const SITE_SECTIONS = { introduction: "自述", chronicle: "时间轴", roll: "连结", preface: "首页简介 / 序文", policy: "网站政策" };
const SITE_NOTE = /^Publish\/site\/(zh-cn|en|ja)\/(introduction|chronicle|roll|preface|policy)\.md$/;

function publishFiles(vault) {
  return vault.getMarkdownFiles().filter(file =>
    file.path.startsWith("Publish/") && !file.path.startsWith("Publish/site/") && !file.name.startsWith("_"));
}

function readProperties(content) {
  const info = getFrontMatterInfo(content);
  if (!info.exists) return undefined;
  try {
    return parseYaml(info.frontmatter);
  } catch {
    return undefined;
  }
}

async function readBlogProperties(directory, type) {
  const entries = await readdir(directory, { withFileTypes: true });
  const groups = await Promise.all(entries.flatMap(entry => {
    if (entry.name.startsWith("_") || entry.name.startsWith(".")) return [];
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return [readBlogProperties(path, type)];
    if (!entry.isFile() || !entry.name.toLowerCase().endsWith(".md")) return [];
    return [readFile(path, "utf8").then(content => [{ type, properties: readProperties(content) }])];
  }));
  return groups.flat();
}

async function loadPostOptions(vault, blogPath) {
  const results = await Promise.allSettled([
    ...["note", "jotting"].filter(() => isAbsolute(blogPath)).map(type =>
      readBlogProperties(join(blogPath, "src", "content", type), type)),
    ...publishFiles(vault).map(async file => {
      const properties = readProperties(await vault.read(file));
      return [{ type: properties?.type, properties }];
    })
  ]);
  const series = new Set();
  const tags = new Set();
  for (const result of results) {
    if (result.status !== "fulfilled") continue;
    for (const { type, properties } of result.value) {
      if ((type !== "note" && type !== "jotting") || !properties) continue;
      if (type === "note" && typeof properties.series === "string" && properties.series.trim()) {
        series.add(properties.series);
      }
      if (Array.isArray(properties.tags)) {
        for (const tag of properties.tags) {
          if (typeof tag === "string" && tag.trim()) tags.add(tag);
        }
      }
    }
  }
  const sort = (left, right) => left.localeCompare(right, "zh-CN");
  return {
    series: [...series].sort(sort),
    tags: [...tags].sort(sort),
    incomplete: results.some(result => result.status === "rejected")
  };
}

function renderBlogTemplate(template, title, slug) {
  const values = new Map([
    ['"<% tp.file.title %>"', JSON.stringify(title)],
    ['<% tp.date.now("YYYY-MM-DD HH:mm:ssZ") %>', JSON.stringify(moment().format("YYYY-MM-DD HH:mm:ssZ"))],
    ['"<% await tp.system.prompt(\'slug（小写英文、数字和连接号）\') %>"', JSON.stringify(slug)],
    ["<% tp.file.cursor() %>", ""]
  ]);
  return template.replace(/"<%[^%]*%>"|<%[^%]*%>/g, marker => {
    if (!values.has(marker)) throw new Error(`模板中有无法自动填写的表达式：${marker}`);
    return values.get(marker);
  });
}

class CreatePostModal extends Modal {
  constructor(app, settings) {
    super(app);
    this.settings = settings;
  }

  onOpen() {
    this.setTitle("新建博客笔记");
    this.contentEl.empty();
    const form = this.contentEl.createEl("form");
    let type = "note";
    let titleInput;
    let slugInput;
    let createButton;
    let seriesSetting;
    let seriesDropdown;
    const selectedTags = new Set();

    new Setting(form).setName("类型").addDropdown(dropdown => {
      dropdown.addOption("note", "文章（note）");
      dropdown.addOption("jotting", "随笔（jotting）");
      dropdown.onChange(value => {
        type = value;
        seriesSetting.settingEl.hidden = type !== "note";
      });
    });
    new Setting(form).setName("标题").setDesc("可选，留空时使用 slug。").addText(text => {
      titleInput = text.inputEl;
    });
    new Setting(form).setName("Slug").addText(text => {
      text.setPlaceholder("my-first-post");
      slugInput = text.inputEl;
      slugInput.setAttribute("aria-label", "Slug");
      slugInput.spellcheck = false;
    });
    seriesSetting = new Setting(form).setName("系列").addDropdown(dropdown => {
      dropdown.addOption("", "不选系列");
      dropdown.selectEl.setAttribute("aria-label", "系列");
      seriesDropdown = dropdown;
    });
    const tagsField = form.createEl("fieldset", { cls: "obsidian2blog-post-tags" });
    tagsField.createEl("legend", { text: "标签（可多选）" });
    const tagsList = tagsField.createDiv({ cls: "obsidian2blog-post-tag-list" });
    const optionsStatus = form.createEl("p", {
      cls: "setting-item-description",
      text: "正在读取系列和标签…",
      attr: { role: "status" }
    });
    void loadPostOptions(this.app.vault, this.settings.blogPath).then(options => {
      for (const series of options.series) seriesDropdown.addOption(series, series);
      for (const tag of options.tags) {
        const label = tagsList.createEl("label");
        const checkbox = label.createEl("input", { type: "checkbox" });
        label.createSpan({ text: tag });
        checkbox.addEventListener("change", () => {
          if (checkbox.checked) selectedTags.add(tag);
          else selectedTags.delete(tag);
        });
      }
      if (!options.tags.length) tagsList.setText("暂无标签");
      optionsStatus.hidden = !options.incomplete;
      optionsStatus.setText(options.incomplete ? "部分来源暂时无法读取，仍可创建草稿。" : "");
    }).catch(() => {
      optionsStatus.setText("无法读取系列和标签，仍可创建草稿。");
    });
    const message = form.createEl("p", { attr: { role: "status" } });
    new Setting(form).addButton(button => {
      button.setButtonText("创建草稿").setCta();
      button.buttonEl.type = "submit";
      createButton = button;
    });
    form.addEventListener("submit", async event => {
      event.preventDefault();
      if (this.creating) return;
      const slug = slugInput.value.trim();
      if (!SLUG.test(slug)) {
        message.setText("Slug 只能使用小写英文字母、数字和分隔用的连字符。");
        slugInput.focus();
        return;
      }
      if (WINDOWS_DEVICE.test(slug)) {
        message.setText("这个 slug 是 Windows 保留名称，请换一个。");
        slugInput.focus();
        return;
      }

      this.creating = true;
      createButton.setDisabled(true);
      message.setText("正在创建草稿…");
      try {
        const file = await this.createPost(type, slug, titleInput.value.trim() || slug, {
          series: seriesDropdown.getValue(),
          tags: [...selectedTags]
        });
        this.close();
        try {
          await this.app.workspace.getLeaf("tab").openFile(file);
        } catch (error) {
          new Notice(`已创建 ${file.path}，打开失败：${error.message}`);
        }
      } catch (error) {
        message.setText(error.message);
      } finally {
        this.creating = false;
        createButton.setDisabled(false);
      }
    });
    slugInput.focus();
  }

  async createPost(type, slug, title, { series, tags }) {
    const vault = this.app.vault;
    const templatePath = `Templates/blog-${type}.md`;
    const template = vault.getAbstractFileByPath(templatePath);
    if (!(template instanceof TFile)) throw new Error(`找不到模板：${templatePath}`);

    const content = renderBlogTemplate(await vault.read(template), title, slug);
    const frontmatter = getFrontMatterInfo(content);
    const properties = parseYaml(frontmatter.frontmatter);
    if (properties?.type !== type || properties.slug !== slug || properties.draft !== true || !properties.locale) {
      throw new Error(`请检查模板的 type、slug、draft 和 locale 属性：${templatePath}`);
    }
    for (const file of publishFiles(vault)) {
      const metadata = readProperties(await vault.read(file));
      if (metadata?.type === type && metadata.locale === properties.locale && metadata.slug === slug) {
        throw new Error(`同类型和语言下已有该 slug：${file.path}`);
      }
    }

    if (type === "note" && series) properties.series = series;
    else delete properties.series;
    properties.tags = tags;
    const draft = `---\n${stringifyYaml(properties).trimEnd()}\n---\n${content.slice(frontmatter.contentStart)}`;

    const parent = `Publish/${type}`;
    const folder = `${parent}/${slug}`;
    if (await vault.adapter.exists(folder)) throw new Error(`目录已存在：${folder}`);

    for (const path of ["Publish", parent]) {
      const current = vault.getAbstractFileByPath(path);
      if (!current) await vault.createFolder(path);
      else if (!(current instanceof TFolder)) throw new Error(`无法用作目录：${path}`);
    }
    const created = [];
    try {
      for (const path of [folder, `${folder}/assets`]) {
        await vault.createFolder(path);
        created.unshift(path);
      }
      return await vault.create(`${folder}/${slug}.md`, draft);
    } catch (error) {
      for (const path of created) {
        await vault.adapter.rmdir(path, false).catch(() => {});
      }
      throw error;
    }
  }
}

class PublishPanel extends Modal {
  constructor(app, openCreator, settings) {
    super(app);
    this.openCreator = openCreator;
    this.settings = settings;
    this.running = false;
    this.output = "";
    this.status = "";
  }

  onOpen() {
    this.setTitle("Obsidian2Blog");
    this.contentEl.empty();
    const vault = this.app.vault;
    if (!(vault.adapter instanceof FileSystemAdapter)) {
      this.contentEl.createEl("p", { text: "请在 Obsidian 桌面版打开本地笔记仓库。" });
      return;
    }

    new Setting(this.contentEl).addButton(button => {
      button.setButtonText("新建博客笔记").onClick(() => {
        this.close();
        this.openCreator();
      });
    });
    const siteFiles = vault.getMarkdownFiles().filter(file => SITE_NOTE.test(file.path));
    const notes = [...publishFiles(vault), ...siteFiles].flatMap(file => {
      const metadata = this.app.metadataCache.getFileCache(file)?.frontmatter;
      return metadata?.draft === false ? [{ file, metadata }] : [];
    });
    notes.sort((left, right) => left.file.path.localeCompare(right.file.path, "zh-CN"));

    const activePath = this.app.workspace.getActiveFile()?.path;
    if (!this.running) {
      const preferred = notes.some(({ file }) => file.path === activePath) ? activePath : this.selected;
      this.select(notes.some(({ file }) => file.path === preferred) ? preferred : notes[0]?.file.path);
    }

    if (notes.length || this.running) {
      new Setting(this.contentEl)
        .setName("笔记")
        .addDropdown(dropdown => {
          for (const { file, metadata } of notes) {
            const site = SITE_NOTE.exec(file.path);
            if (site) {
              dropdown.addOption(file.path, "网站内容 · " + SITE_SECTIONS[site[2]] + " · " + site[1]);
              continue;
            }
            const destination = [metadata.type, metadata.locale, metadata.slug].filter(Boolean).join("/");
            dropdown.addOption(file.path, `${metadata.title || file.basename} · ${destination || file.path}`);
          }
          dropdown.setValue(this.selected || "").onChange(value => {
            this.select(value);
            this.render();
          });
          this.dropdown = dropdown;
        });
      new Setting(this.contentEl).addButton(button => {
        button.setButtonText("同步到本地").onClick(() => this.run("sync"));
        this.syncButton = button;
      }).addButton(button => {
        button.setButtonText("同步并构建").onClick(() => this.run("build"));
        this.buildButton = button;
      }).addButton(button => {
        button.setButtonText("发布到 GitHub").setCta().onClick(() => this.run("publish"));
        this.publishButton = button;
      });
      this.contentEl.createEl("p", {
        cls: "setting-item-description",
        text: "同步会更新对应文章或网站区块。发布还会推送目标分支上已有的待推送提交。"
      });
    } else {
      this.contentEl.createEl("p", {
        text: "当前没有可发布内容。将文章或 Publish/site 下的页面笔记的 draft 设为 false 即可发布。"
      });
    }

    this.statusEl = this.contentEl.createEl("p", { attr: { role: "status" } });
    this.logEl = this.contentEl.createEl("pre", { cls: "obsidian2blog-publish-log" });
    this.render();
  }

  select(path) {
    if (path === this.selected) return;
    this.selected = path;
    this.output = "";
    this.status = "";
  }

  render() {
    this.dropdown?.setDisabled(this.running);
    this.buildButton?.setDisabled(this.running);
    this.syncButton?.setDisabled(this.running);
    this.publishButton?.setDisabled(this.running);
    this.statusEl?.setText(this.status);
    if (this.logEl) {
      this.logEl.hidden = !this.output;
      this.logEl.setText(this.output);
      this.logEl.scrollTop = this.logEl.scrollHeight;
    }
  }

  async run(mode) {
    if (this.running || !this.selected) return;
    this.running = true;
    this.output = "";
    this.status = "处理中…";
    this.render();
    try {
      const { blogPath, node, remote, branch } = this.settings;
      if (!isAbsolute(blogPath)) throw new Error("请先在 Obsidian2Blog 设置中填写博客绝对路径。");
      const script = join(blogPath, "scripts", "publish.ts");
      if (!existsSync(script)) throw new Error(`找不到博客发布脚本：${script}`);
      const vaultRoot = this.app.vault.adapter.getBasePath();
      const args = ["--import", "tsx", script, "--obsidian", join(vaultRoot, this.selected)];
      if (mode !== "build") args.push("--skip-check");
      if (mode === "publish") args.push("--push");
      const status = await new Promise((resolve, reject) => {
        const child = spawn(node, args, {
          cwd: blogPath,
          env: { ...process.env, OBSIDIAN_VAULT: vaultRoot, OBSIDIAN_BLOG_REMOTE: remote, OBSIDIAN_BLOG_BRANCH: branch, NO_COLOR: "1" },
          stdio: ["ignore", "pipe", "pipe"],
          windowsHide: true
        });
        const append = chunk => {
          this.output = (this.output + stripVTControlCharacters(chunk)).slice(-30000);
          this.render();
        };
        child.stdout.setEncoding("utf8").on("data", append);
        child.stderr.setEncoding("utf8").on("data", append);
        child.once("error", reject);
        child.once("close", resolve);
      });
      if (status !== 0) throw new Error("操作未完成，详情见日志。");
      this.status = {
        sync: "本地同步完成。",
        build: "本地同步、Astro 检查与构建完成。",
        publish: "已推送到 GitHub。请在 Actions 查看部署状态。"
      }[mode];
    } catch (error) {
      this.status = error.message;
    } finally {
      this.running = false;
      this.render();
      new Notice(this.status);
    }
  }
}

module.exports = class Obsidian2Blog extends Plugin {
  async onload() {
    this.settings = { ...DEFAULTS, ...await this.loadData() };
    this.addSettingTab(new BlogSettings(this.app, this));
    const openCreator = () => {
      this.creator ??= new CreatePostModal(this.app, this.settings);
      if (!this.creator.creating) this.creator.open();
    };
    const open = () => {
      this.panel ??= new PublishPanel(this.app, openCreator, this.settings);
      this.panel.open();
    };
    this.addRibbonIcon("upload-cloud", "Obsidian2Blog", open);
    this.addCommand({ id: "open-publish-panel", name: "打开发布面板", callback: open });
    this.addCommand({ id: "create-blog-post", name: "新建博客笔记", callback: openCreator });
  }

  onunload() {
    this.panel?.close();
    this.creator?.close();
  }
};
