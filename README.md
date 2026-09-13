# 【弃用】dsh-two-stage-promotion

## 已弃用: V4.1 Flash 实现了 32/32 的全锚定

---

二阶段晋升模式 —— dsh web GUI 的 agent preset 插件(host half),不带浏览器 half。

- **阶段一(锚定)**:首轮模型请求仅暴露官方 Minimal 的精确表面(0.1.5-rc.1 起为单件持久 `bash`,旧版为 `bash` + `str_replace_editor` 双工具)、单行 persona、无运行时上下文、无注入指令,锚定 Minimal 推理轨迹;
- **晋升**:首块 Minimal 风格推理(含 `we` 且无 `let me`)或首个工具调用触发晋升,四步兜底;无工具首轮在响应后自动晋升;
- **阶段二(完整)**:晋升后 wire 切换为 PTC Mode(单一 `run_code`,覆盖完整工具注册表),workspace 指令与 skill 目录延迟一步注入。

宿主启动时,插件把包内 `presets/` 树同步到 `~/.dsh/.agent-presets`,新会话的预设选择器中即可选「二阶段晋升模式」。

## DSH 版本适配

当前面向 **DSH 0.1.5-rc.1** 的 preset 表面(见 `dsh.engines.dsh`):

| 适配点 | 旧版形态 | 0.1.5-rc.1 形态 |
|---|---|---|
| Minimal 工具面 | 持久 `bash` + `str_replace_editor` | 仅持久 `bash`(单工具) |
| persona 插件字段 | `text` | `prefix`(`text` 已移除,`prefix` 为必填) |
| persona section 名 | `deployment:persona` | `deployment:persona-prefix` / `-suffix` |
| 工具呈现模式 | `tools.presentAs('code')` | `tools.presentAs('ptc')` |

Session API 仍做特性检测,兼容旧字段:

```js
const events = Array.isArray(session?.events)
  ? session.events                     // 旧版 DSH(< 0.1.2-rc.1)
  : typeof session?.snapshotEvents === 'function'
    ? session.snapshotEvents()         // 新版 DSH(>= 0.1.2-rc.1,含 0.1.5-rc.1)
    : []
```

但 preset 的 persona 行只能写一种 schema,因此**运行 0.1.5-rc.1 之前的 DSH 请使用旧版本插件**。

## 观察与验收

运行时有三处可直接观察,不需要读代码:

| 观察面 | 位置 | 看什么 |
|---|---|---|
| GUI 轨迹视图 | 会话内切到「轨迹」标签页 | `系统提示词和工具已更新` 标记 = 晋升 / 压缩边界;工具列在阶段一是单个 `bash`,阶段二是单个 `run_code` |
| 会话日志 | `~/.dsh/sessions/<workspace>/<session>/session.v3.jsonl.zstd` | 每次请求的 wire 工具面与 `maxTokens`;`system/message` 记录渲染出的 system prompt;`user/message.source.kind` 记录注入来源 |
| 诊断日志 | `/tmp/two-stage-promotion-crash.log` | `MOUNT ... V4` 表示加载了哪一代代码;任何监听器抛错都会带栈写在这里 |

会话日志是逐次追加的**多帧** zstd,`zstdDecompressSync` 一次只解一帧,用仓库脚本还原时间线:

```bash
node tools/observe-session.mjs ~/.dsh/sessions/<workspace>/<session>/session.v3.jsonl.zstd
```

```text
位置      事件                    模型可见面
          request/header         受控 · 单工具(bash)        maxTokens=1024   [bash]        ← 面切换
          tool/call              bash
          system prompt          1 行 / 46 字符
          request/header         晋升后 · PTC(仅 run_code)  maxTokens=未设置  [run_code]    ← 面切换
```

每个阶段该看到什么,见 [`doc/二阶段晋升提示词规范.md`](doc/二阶段晋升提示词规范.md) 第十章。

## 安装

```bash
dsh plugin --profile web add dsh-two-stage-promotion
```

重启 dsh web 服务后生效。

## 结构

```
lib/index.js                宿主插件:启动时同步 presets/ → ~/.dsh/.agent-presets
presets/two-stage-promotion/ 预设本体(agent.cordis.yml + tool-bootstrap.mjs 等)
cordis.patch.yml            profile bundle patch(插入宿主插件行)
```

## 出处

派生自 `@linxin666/dsh-liangshen`(Apache-2.0),

后者又派生自 `xiaobright/dsh-anchored-standard`(MIT)。
详见 [NOTICE](./NOTICE)。
