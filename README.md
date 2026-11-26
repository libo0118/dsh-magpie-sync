# Magpie 模型同步 · DSH 插件

0.2.0 版：从 Magpie 的已鉴权 `/models` 目录读取元数据，支持一键同步当前提供商全部已配置模型、只读差异检测、单模型同步、目录预览与配置撤销。

适配：DSH Desktop `0.2.1-rc.5` – `0.2.2-rc.3`，pi-ai 自定义提供商，`openai-responses`、`openai-completions`、`anthropic-messages`。

## 使用

1. 打开 DSH「设置 → 模型」，向下滚动到 **Magpie 模型同步**。
2. 面板会自动以只读方式检测当前选定 Magpie 提供商与上游目录的差异，并在主按钮提示可更新的模型数量。
3. 点击 **同步全部已配置模型**，一次性为该提供商下的所有已配置模型拉取最新元数据、自动备份并即时应用。
4. 如只需更新当前会话正在使用的单个模型，可点击 **仅同步当前所选模型**。
5. 需要批量查看细节或新增模型时，点击 **获取目录与预览**，查看差异或搜索勾选目录项，再点击 **预览所选模型** → **应用此预览**。

所有写操作均由手动按钮触发，不运行后台定时任务。切换 **max 使用上游 ultra** 选项后，面板会重新检测差异；再次点击同步按钮才会写入模型配置。

当前所选模型来自 DSH 主页面会话的已确认选择；模型正在切换或会话在请求中切换时会提示重试。单模型同步按精确的提供商 ID 和模型 ID 查找，不自动添加或更改其他模型。模型未出现在 Magpie 目录时保留原配置并提示。

名称默认保留用户现有名称。目录里暂未出现的模型原样保留并列出，不推断别名。请求使用 DSH 凭据服务保存的 API key，密钥和认证头不进入预览、模型备份或日志。

## 档位映射

以 Magpie 实际公布的档位为准，例如：

| Magpie 模型 | 目录能力示例 |
| --- | --- |
| `gpt-6-astra` | 872,000 上下文 / 128,000 输出；文本+图片；low / medium / high / xhigh / max / ultra |
| `qoder/gfmodel` | 1,000,000 / 128,000；文本+图片；high / max |
| `workbuddy/deepseek-v4.1-flash` | 1,000,000 / 128,000；文本+图片；none / low / high / max |
| `agy-cli/claude-opus-5-5` | 1,000,000 / 64,000；文本+图片；low / medium / high |

以上是本机 2026-11-17 读取的目录声明，后续以接口返回为准；没有通过推理请求测量容量。

DSH 当前界面可选 `off / minimal / low / medium / high / xhigh / max`：

- Magpie `none`、`disabled`、`off` 对应 DSH `off`，API 参数保留上游原始值。
- 上游未声明关闭思考时，不生成额外的 `off`。
- `ultra` 会显示在目录说明中。默认保留 `max → max`；开启面板中的 **max 使用上游 ultra** 后改为 `max → ultra`。
- 上游没有公布的字段保留现有配置；不依据模型名称猜测能力。
- Messages 路由仅对明确公布 effort 档位的模型补齐 `compat.forceAdaptiveThinking`；显式预算模式设置保持原值。
- `tool_call: false` 的模型会展示说明，新增导入按钮禁用；现有模型不被删除。
- `native_endpoints` 保留在目录预览数据中，不自动切换整个提供商的协议。

## 同步选项

在插件的设置页可调整：

| 配置 | 默认 | 说明 |
| --- | --- | --- |
| `providerIds` | `[]` | 额外识别的 pi-ai 提供商 ID；默认匹配地址中 `/magpie/` 或名称中 Magpie |
| `preserveNames` | `true` | 保留现有显示名称 |
| `ultraAsMax` | `false` | 显式启用 `max → ultra` |

ultra 映射也可直接在 Models 页脚调整；它只影响下一次手动同步。

## 备份与撤销

每次实际写入前保存模型数组备份到 `$DSH_HOME/magpie-model-sync/backups/<id>.json`，不含提供商凭据。面板显示 **撤销最近一次同步**。

撤销前检查当前模型仍与备份的同步结果一致，防止覆盖之后的手工修改。撤销后配置保持为恢复结果，直到下一次手动修改或同步。

预览有效期 5 分钟。应用使用 DSH 的修订号与配置写锁；其他标签页修改或端点/选项变化后要求重新预览。

## 安装

### 方式一：通过 GitHub / 压缩包安装（推荐）

在 DSH「设置 → 插件管理」中直接安装以下地址：

- GitHub 仓库：`github:libo0118/dsh-magpie-sync`
- 或从 GitHub Releases 下载 `dsh-magpie-sync-*.tgz` 后在插件管理页导入安装。

### 方式二：本地源码开发安装

已编译包无构建脚本，不修改 DSH 应用文件。也可直接在插件管理页选择插件的绝对目录安装；本机源码链接工具：

```powershell
node tools/install-local.mjs
```

工具读取当前会话的 `DSH_PROFILE_DIR` 与 `DSH_IMPLEMENTATION_DIR`，使用 DSH 官方原子写与锁函数保存 manifest，创建本地 link 并验证 profile 组合。该模式适用于本地开发；源码目录须保留。插件管理页可停用或移除本插件。

Host 代码更新后通过插件管理页关闭再开启本插件，重新载入模块；浏览器刷新同一 DSH 页面以确认更新。

## 验证

本机执行了 13 项离线验证，覆盖真实 223 条目录解析、增量合并与幂等、稀疏元数据、ultra 映射、GET/分页/重定向/大小限制、鉴权错误、无工具模型、修订冲突、备份撤销、React 组件渲染、Messages 真实序列化、启动零后台任务、单模型同步保留其他模型，以及当前会话模型读取与切换处理。

```powershell
node --test test/*.test.mjs
```

测试使用本机 DSH 共享包及 `tools/test-deps` 的 React 18；协议序列化验证当前绑定到本机 DSH runtime。安装包只包含运行代码与文档，完整开发目录包含测试与脱敏的模型目录样本。

## 实现

- `lib/core.js`：有限大小与时限的目录请求、分页、字段归一化、档位映射、差异计划。
- `lib/index.js`：Cordis Host 插件、DSH 凭据与设置服务、手动单模型同步、配置备份、鉴权后的 Fetch 路由。
- `lib/client.js`：共享 React factory，注册官方 `settings.models.footer` 插槽，通过 `uiSession.current` 与 `modelDirectories` 读取当前会话所选模型。
