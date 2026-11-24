# Obsidian2Blog

在 Obsidian 里写文章，准备好后，从侧栏发布到自己的博客。

Obsidian2Blog 包含一个 Obsidian 桌面插件和一个基于 ThoughtLite 的 Astro 博客模板。插件可以创建文章或随笔，生成图片目录，并从已有的系列和标签中读取选项。发布时，它会转换 Markdown 和引用的图片，检查并构建站点，然后通过本地 Git 提交和推送。GitHub Actions 负责部署 GitHub Pages。

## 准备网站

1. 克隆自己的博客仓库，进入仓库根目录，用 Node.js 22 和 Git 在本地运行 `npm ci`、`npm run dev`。
2. 编辑 `site.config.json`，填写站点名称、作者和网址。对于 `https://your-name.github.io/my-blog/`，设置 `site` 为 `https://your-name.github.io`，`base` 为 `/my-blog`。使用根域名时将 `base` 设为 `/`。
3. 将仓库推到 GitHub，在 **Settings → Pages** 选择 **GitHub Actions**。工作流默认监听 `main`。使用其他分支时，同时更新 `.github/workflows/deploy.yml` 和插件设置。

## 安装插件

1. 将 `obsidian-plugin/` 里的 `main.js`、`manifest.json` 和 `styles.css` 复制到 Obsidian 仓库的 `.obsidian/plugins/obsidian2blog/`。
2. 将 `vault-templates/` 中的两份 Markdown 复制到同一仓库的 `Templates/`。重启 Obsidian，在第三方插件中启用 **Obsidian2Blog**。
3. 打开插件设置，填入本地博客根目录的绝对路径。默认使用 PATH 上的 `node`，Git 远端默认是 `origin`，部署分支默认是 `main`。请先确认本地 Git 有目标仓库的推送权限。

## 写作和发布

1. 点左侧云上传图标，选择 **新建博客笔记**。填写用于网址的 slug，例如 `my-first-post`。文章可选一个系列，文章和随笔均可选多个标签。
2. 原稿保存在 `Publish/<type>/<slug>/<slug>.md`。把图片放进同级 `assets/`，使用 `![[assets/overview.png]]` 引用。如果希望粘贴图片时自动存入该目录，在 Obsidian 的附件位置配置中选择当前文件所在文件夹下的子文件夹，并填入 `assets`。
3. 写完后把 `draft` 改成 `false`。在发布面板选中文章，可以先 **预览**，也可以直接点 **发布到 GitHub**。推送后在博客仓库的 **Actions** 查看部署进度。

以后修改同一篇文章，只要保留 `type`、`locale` 和 `slug`，再次发布就会更新原网址。插件每次打开新建表单时，会重读博客内容和 `Publish/` 中的系列、标签。同步和发布都由按钮触发。

## 来源与许可

网站基于 [tuyuritio 的 ThoughtLite](https://github.com/tuyuritio/astro-theme-thought-lite)，保留主题的基础布局、默认字体、图标及许可证。本项目增加了 Obsidian 插件、笔记转换脚本和 GitHub Pages 部署配置。源码按 [GPL-3.0](LICENSE) 分发。
