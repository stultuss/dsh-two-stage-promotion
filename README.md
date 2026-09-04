# dsh-two-stage-promotion

二阶段晋升模式 —— dsh web GUI 的 agent preset 插件(host half),不带浏览器 half。

- **阶段一(锚定)**:首轮模型请求仅暴露官方 Minimal 精确双工具(持久 `bash` + `str_replace_editor`)、单行 persona、无运行时上下文、无注入指令,锚定 Minimal 推理轨迹;
- **晋升**:首块 Minimal 风格推理(含 `we` 且无 `let me`)或首个工具调用触发晋升,四步兜底;无工具首轮在响应后自动晋升;
- **阶段二(完整)**:晋升后 wire 切换为 PTC Mode(单一 `run_code`,覆盖完整工具注册表),workspace 指令与 skill 目录延迟一步注入。

宿主启动时,插件把包内 `presets/` 树同步到 `~/.dsh/.agent-presets`,新会话的预设选择器中即可选「二阶段晋升模式」。

## 新旧 DSH 双版本兼容

preset 插件(`presets/two-stage-promotion/tool-bootstrap.mjs`)对 Session API 做特性检测:

```js
const events = Array.isArray(session?.events)
  ? session.events                     // 旧版 DSH(< 0.1.2-rc.1)
  : typeof session?.snapshotEvents === 'function'
    ? session.snapshotEvents()         // 新版 DSH(>= 0.1.2-rc.1,含 0.1.2-rc.1)
    : []
```

`engines.dsh` 声明为 `>=0.1.2-alpha.4`,同时覆盖新旧两个 DSH 版本。

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
