# Embedded Note Enhancer

为 Obsidian 中的嵌入笔记添加可交互的标题栏，支持折叠/展开、原地编辑和快速跳转功能

> 我没有Typescript研发经验，这款插件是我和 AI 共同完成，作为 Beta 版请谨慎使用。

[![GitHub release](https://img.shields.io/github/v/release/amazinday/embedded-note-enhancer)](https://github.com/amazinday/embedded-note-enhancer/releases)
[![GitHub downloads](https://img.shields.io/github/downloads/amazinday/embedded-note-enhancer/total)](https://github.com/amazinday/embedded-note-enhancer/releases)
[![GitHub stars](https://img.shields.io/github/stars/amazinday/embedded-note-enhancer)](https://github.com/amazinday/embedded-note-enhancer/stargazers)
[![License](https://img.shields.io/github/license/amazinday/embedded-note-enhancer)](LICENSE)

## ✨ 功能特性

- 🎯 **智能标题栏** - 为每个嵌入的笔记自动添加可交互的标题栏,点击标题栏即可折叠或展开嵌入内容，支持状态记忆
- ✏️ **原地编辑** - 无需跳转即可直接编辑嵌入的笔记内容
- 🔗 **快速跳转** - 一键跳转到源文件，支持新标签页或当前视图
- 🎨 **主题兼容** - 完美适配 Obsidian 的各种主题，包括暗色/亮色模式
- 📱 **响应式设计** - 支持移动端和桌面端
- 🖼️ **智能文件识别** - 自动识别图片和 PDF 文件，保持 Obsidian 原生显示效果

## 🚀 快速开始

### 安装方式

#### 方式一：通过 Obsidian 社区插件市场（推荐）
1. 打开 Obsidian 设置 → 第三方插件
2. 关闭安全模式（如果已关闭则跳过）
3. 点击"浏览"按钮
4. 搜索 "Embedded Note Enhancer"
5. 点击安装并启用

#### 方式二：手动安装
1. 下载 [最新版本](https://github.com/amazinday/embedded-note-enhancer/releases/latest)
2. 解压下载的 `embedded-note-enhancer-1.0.0.zip` 文件
3. 将 `main.js`、`manifest.json` 和 `styles.css` 复制到你的 vault 的 `.obsidian/plugins/embedded-note-enhancer/` 文件夹中
4. 重新加载 Obsidian
5. 在设置 → 第三方插件中启用 "Embedded Note Enhancer"

### 📦 下载链接

| 版本 | 发布日期 | 下载链接 | 说明 |
|------|----------|----------|------|
| 1.0.0 | 2024-09-23 | [📥 下载](https://github.com/amazinday/embedded-note-enhancer/releases/download/1.0.0/embedded-note-enhancer-1.0.0.zip) | 正式版发布 |

> 💡 **提示**: 如果没有看到社区插件市场选项，可以直接下载最新版本进行手动安装。

## 📖 使用指南

### 基本功能

插件会自动为你的嵌入笔记添加标题栏。以下是主要功能：

#### 1. 折叠/展开嵌入内容
- 点击标题栏即可折叠或展开嵌入内容
- 折叠状态会自动保存，下次打开文件时保持

#### 2. 原地编辑
- 点击标题栏右侧的"编辑"按钮进入编辑模式
- 直接修改嵌入的笔记内容
- 支持自动保存或手动保存（Ctrl+S）

#### 3. 快速跳转
- 点击"跳转"按钮快速跳转到源文件
- 可在设置中选择在新标签页或当前视图中打开

### 支持的嵌入语法

插件支持以下 Obsidian 嵌入语法：

```markdown
![[笔记名称]]
![[笔记名称#标题]]
![[笔记名称^块引用]]
```

## ⚙️ 配置选项

在 Obsidian 设置 → 第三方插件 → Embedded Note Enhancer 中可以配置以下选项：

| 设置项 | 描述 | 默认值 |
|--------|------|--------|
| 字体大小 | 标题栏字体大小 | 14px |
| 显示折叠图标 | 在标题栏显示折叠/展开图标 | ✅ |
| 显示编辑按钮 | 在标题栏显示编辑按钮 | ✅ |
| 显示跳转按钮 | 在标题栏显示跳转按钮 | ✅ |
| 跳转方式 | 跳转时在新标签页或当前视图打开 | 新标签页 |
| 仅手动保存 | 关闭自动保存，仅手动保存 | ❌ |
| 调试模式 | 开启后会在控制台输出详细的调试信息 | ❌ |

## 🎨 界面预览

### 展开状态

<img width="1058" height="885" alt="expanded" src="https://github.com/user-attachments/assets/9b1fa44f-8d6f-45f9-9538-d0af166b95ca" />

### 折叠状态

<img width="1057" height="138" alt="collapsed" src="https://github.com/user-attachments/assets/fd59bad7-be2a-419b-bf1a-f9a73ec8c0ec" />

### 编辑状态

<img width="1065" height="822" alt="editing" src="https://github.com/user-attachments/assets/de657cc7-1fbd-450e-a764-ad51ac0afb0e" />

## 🔧 高级功能

### 嵌套嵌入支持
插件完全支持嵌套嵌入，每个层级的嵌入都会获得独立的标题栏：

<img width="1050" height="451" alt="nested" src="https://github.com/user-attachments/assets/782af861-d988-417b-8bd0-add32ec829ea" />

### 图片嵌入智能识别
插件会自动识别图片嵌入，不对其添加标题栏，保持 Obsidian 原生显示效果。

### PDF 文件支持
插件会自动识别 PDF 文件嵌入（如 `![[example.pdf]]`），并使用 Obsidian 原生的 PDF 查看器显示，不会添加自定义标题栏或干预 PDF 的显示和交互。

## 🐛 故障排除

### 常见问题

**Q: 标题栏没有显示**
A: 请确保插件已启用，并重新加载 Obsidian。如果问题持续，请检查是否有其他插件冲突。

**Q: 编辑功能不工作**
A: 请确保你有权限编辑源文件，并检查文件路径是否正确。

**Q: 跳转功能异常**
A: 请检查源文件是否存在，并确保文件路径正确。

**Q: 样式显示异常**
A: 请尝试切换主题或重新加载 Obsidian。如果使用自定义 CSS，请检查是否有冲突。

### 调试模式

如果需要调试插件问题，可以：

1. **开启调试模式**：在插件设置中开启"调试模式"选项
2. **查看控制台日志**：打开浏览器开发者工具（F12），在控制台中查看详细的调试信息
3. **手动触发处理**：在控制台中运行以下命令手动触发插件处理：

```javascript
// 手动触发插件处理
window.embeddedNoteEnhancerPlugin?.manualTrigger();
```

**注意**：调试模式会产生大量日志输出，建议仅在排查问题时开启。

## 🛠️ 开发指南

### 环境要求
- Obsidian 0.15.0+
- Node.js 16+
- TypeScript 4.7+

### 本地开发

```bash
# 克隆仓库
git clone https://github.com/amazinday/embedded-note-enhancer.git

# 安装依赖
npm install

# 开发模式
npm run dev

# 构建
npm run build
```

### 项目结构

```
embedded-note-enhancer/
├── main.ts              # 主插件文件
├── styles.css           # 样式文件
├── manifest.json        # 插件清单
├── package.json         # 项目配置
├── tsconfig.json        # TypeScript 配置
└── esbuild.config.mjs   # 构建配置
```

## 🤝 贡献指南

我们欢迎社区贡献！如果你想为这个项目做出贡献：

1. Fork 这个仓库
2. 创建你的特性分支 (`git checkout -b feature/AmazingFeature`)
3. 提交你的更改 (`git commit -m 'Add some AmazingFeature'`)
4. 推送到分支 (`git push origin feature/AmazingFeature`)
5. 打开一个 Pull Request

### 贡献类型
- 🐛 Bug 修复
- ✨ 新功能
- 📚 文档改进
- 🎨 样式优化
- ⚡ 性能优化

## 📄 许可证

本项目基于 MIT 许可证开源 - 查看 [LICENSE](LICENSE) 文件了解详情。

## 🙏 致谢

- 感谢 Obsidian 团队提供的优秀平台
- 感谢社区用户的反馈和建议
- 感谢所有贡献者的努力

## 📞 支持

如果你觉得这个插件有用，请：

- ⭐ 给这个项目点个星
- 🐛 [报告问题](https://github.com/amazinday/embedded-note-enhancer/issues)
- 💡 [提出建议](https://github.com/amazinday/embedded-note-enhancer/discussions)
- 📢 [分享给朋友](https://github.com/amazinday/embedded-note-enhancer)
- 📥 [下载最新版本](https://github.com/amazinday/embedded-note-enhancer/releases/latest)

## 📈 更新日志

### 1.0.0 (2024-09-23)
- 🎉 正式版发布
- 🎯 智能标题栏 - 为嵌入笔记添加可交互标题栏
- 📁 折叠/展开功能 - 支持状态记忆
- ✏️ 原地编辑 - 无需跳转即可编辑内容
- 🔗 快速跳转 - 一键跳转到源文件
- 🎨 主题兼容 - 完美适配各种主题
- 📱 响应式设计 - 支持移动端和桌面端
- 🔄 嵌套支持 - 完全支持多层嵌套嵌入
- ⚙️ 丰富配置 - 多种自定义选项
- 🐛 稳定性优化 - 修复已知问题，提升用户体验

---

<div align="center">

**Made with ❤️ for the Obsidian community**

[⬆ 回到顶部](#embedded-note-enhancer)

</div>
