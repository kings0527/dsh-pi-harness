# DSH Quest Router 0.1

一个以可验证证据控制多模型尝试、隔离主线与副本上下文的独立 DSH 插件。可与 `dsh-pi-harness` 并用，不修改 DSH 执行循环，不需要第三方 Node 依赖。

状态：**可测试原型**。内核、真实本地验收子进程、DSH 接口替身测试已经覆盖；未连接用户的 DSH 实例和模型账号进行端到端验证。不提供 MoE 专家选择、语义穷举保证或沙箱。

## 核心行为

- 主模型提出副本的目标、入口事实、出口条件和预先配置的验收器。
- 插件创建 fresh `spawn` 子会话，固定一种实验方法，按模型配置运行。
- 子模型提交可证伪假设、区分性实验、预测观察、结论和局限。
- 插件运行固定的外部验收器。只有它返回的、有文件证据的结构化观察才记为进展；模型自评、日志字节变化、耗时和工具等待都不算。
- 同一证据版本下，不同方法连续没有新观察，就换下一条可配置模型路线。模型自称失败不会直接购买更贵的路线。
- 验收通过后，只返回简短结论及证书引用。原始尝试、精确 capsule、验收日志保留在 `.quest-router/`；完整工具轨迹仍由 DSH 子会话保存，账本记录 `childId`。
- 逻辑副本可以有 parent 和依赖关系，但实验 worker 不继续递归委派，避免多层摘要传话。所有副本由同一协调器管理。
- 上游证书被撤销、证据文件变化或依赖版本变化，下游证书不再有效。
- 绑定 `blocksMainline: true` 的副本耗尽或执行失败，通过 DSH `goals.block()` 阻止 goal 自动续跑。其他副本失败不阻断无关主线。

## 安装

把本目录放到稳定路径，通过 DSH 的 Plugin Manager 安装本目录：

```text
plugin_manager install_bundle target="/absolute/path/to/quest-router"
```

Windows 使用实际的 Windows 绝对路径。与原 `dsh-pi-harness` 是两个 bundle，不要重复挂载。

需要 DSH 的 `subagents`、fresh `spawn` backend、`tools`、`workingDirectory`、`llm`、`systemPrompt` 服务；若需要阻止 goal 续跑，还需要 `goals`。实现参照上游源码 `687f282e8625c6b8d11ff58211a90524be2e4317`（检查日期 2026-10-21），不是对所有旧版本的兼容承诺。缺少所需 API 会明确报错。

## 配置

模型 id 使用当前 DSH `list_subagent_models` 返回的 **provider / model / reasoning effort**，不要照抄其他机器的 provider 名。配置中的 routes 是插件可使用的显式清单；会话另有更窄的模型清单时取交集。

先把任务专用验收脚本放进项目。用 `node /path/to/quest-router/cli.js pin verify.mjs` 得到 SHA256，填进配置。这个脚本必须独立于 solver 的成功宣言，验证实际可复现的结果。示例脚本只用于演示。

在 profile 的 `cordis.patch.yml` 配置现有 row：

```yaml
- id: quest-router
  config:
    maxAttempts: 12
    maxSessionAttempts: 48
    stagnantAttempts: 2
    attemptTimeoutMs: 600000
    checkTimeoutMs: 60000
    methods: [forward, backward, minimize, falsify]
    routes:
      - id: flash
        provider: YOUR_DEEPSEEK_PROVIDER_ID
        model: deepseek-flash
        reasoningEffort: high
        tier: 0
        cost: 1
      - id: alternative
        provider: YOUR_GLM_PROVIDER_ID
        model: glm-5.3
        reasoningEffort: max
        tier: 1
        cost: 4
    checks:
      exit:
        command: /absolute/path/to/node
        args: [verify.mjs]
        pins:
          verify.mjs: REPLACE_WITH_ACTUAL_SHA256
```

这里的 `cost` 是同层路线的配置排序权重，**没有接入真实价格或计费**；`tier` 表示你的路由优先级，不代表通用智力排行。`stagnantAttempts` 是已声明方法、固定证据版本、没有可验证新观察的局部预算，不是“每 N 轮强制切模型”。当前策略是可解释启发式，没有宣称已校准成功概率。

所有实际引用的验收代码和依赖文件都应列入 `pins`。运行前后都会检查 pin。pin 和 hash 用于发现变化，不能抵御拥有同一文件系统写权限的恶意 worker。不要把验收器当成隔离环境。

## 使用

```text
quest action=create id="step-eight"
  objective="确定从 8 到 9 的必要条件并复现"
  entry="已确认的入口状态及其来源；尚未确认的前提放到 assumptions"
  exit="verify.mjs 独立验收复现产物"
  check="exit"
  assumptions=["步骤 7 的环境假设仍成立"]
  inputs=["reproduction-input.json","failure-trace.txt"]
  blocksMainline=true

quest action=run id="step-eight"
quest action=status id="step-eight"
```

`run` 由外部调度器执行这一副本的多个尝试，直到验收通过、路由政策耗尽、预算耗尽或执行失败。主线不需要逐次接收原文。原始输入会复制到有 SHA256 的文件引用；过大的 capsule 会返回完整文件的读取指针，不静默截断。

子副本与依赖：

```text
quest action=create id="eight-environment" parent="step-eight" ...
quest action=depend id="step-eight" dependsOn=["eight-environment"]
quest action=run id="eight-environment"
quest action=run id="step-eight"
```

`parent` 是逻辑目录，`dependsOn` 才是需要有效证书的前提。依赖可以跨层引用，循环会被拒绝。前提被反证时：

```text
quest action=invalidate id="eight-environment" reason="新的复现实验证明前提不成立，见 artifact ..."
```

撤销会增加该 case 的 epoch，清除当前证书与观察；历史尝试仍完整保留。总尝试预算按 case 的完整历史计数，不会因模型反复 invalidate 而自动获得无限预算。改变验收器配置必须创建新 case，不能让旧 case 的已验收出口悄悄改变。

`maxSessionAttempts` 约束同一项目、同一 DSH session 下所有副本的累计模型尝试。创建新 ID 不会重置这个额度。此额度不计量 root agent 在插件之外的 token 与工具开销；它不能代替整个 harness 的账户费用上限。

## 验收器协议

验收器是配置中的程序和 argv，`shell:false`。stdin 是 JSON，含 `id / epoch / number / contract / candidate`；baseline 的 candidate 为 null。stdout 必须只包含一个 JSON 对象，stderr 可记日志。

```json
{
  "accepted": false,
  "facts": [
    {"key":"input-a-reaches-branch-17","value":true,"evidencePaths":["branch-17-trace.json"]}
  ]
}
```

`key` 必须表示一个明确、可复验、带条件的观察；value 是字符串、数值或布尔值。进展以新 `key/value` 计，不以日志 hash 计。`accepted:true` 至少需要一个带文件证据的观察。程序必须以 0 退出；假设被证伪使用 `accepted:false`，程序启动失败、非零退出、超时、非法 JSON、pin 变化是执行故障，会停止调度，不会被解释为模型能力不足。

验收器决定“出口是否通过”，不保证 summary 中每一句解释都正确，也不证明审计完整或不存在漏洞。没有可执行的出口条件时，先把目标收窄为可验证的中间产物；只靠另一个模型同意，不能获得同等级的验收证据。

## 策略参数

| 参数 | 默认 | 作用 |
|---|---:|---|
| `maxAttempts` | 12 | 每 case 的总尝试上限 |
| `maxSessionAttempts` | 48 | 同项目、同 session 全部 case 的共享模型尝试上限 |
| `stagnantAttempts` | 2 | 同证据版本、同 route，无新增验证观察的尝试阈值；还要求覆盖不同方法 |
| `attemptTimeoutMs` | 600000 | 一个子会话的时间上限；不是能力判定器 |
| `checkTimeoutMs` | 60000 | 验收器超时 |
| `maxCheckBytes` | 65536 | stdout JSON 的解析上限；完整日志保留 |
| `maxConclusionBytes` | 2400 | 子报告的 UTF-8 字节上限，超出报告不准入 |
| `maxCapsuleBytes` | 16384 | 超出后改为完整 capsule 文件引用 |
| `repeatToolResults` | 3 | 同输入/同输出工具调用的提示阈值；不触发模型切换 |
| `blockGoalOnExhaustion` | true | 允许绑定主线的副本调用 `goals.block()` |
| `workerPreset` | 无 | 可选的、已在 DSH 注册的 worker preset |

## 测试和检查

```bash
npm test
npm run demo
node cli.js status /path/to/project
node cli.js inspect /path/to/project step-eight
```

demo 使用模拟模型、真实的本地验收子进程，会展示两种 cheap 方法无进展后切到另一条路线、验收通过并产生证书。它不是 DeepSeek / GLM 的能力对比结果。

## 原型的实际边界

1. **上下文隔离，工作目录共享。** 插件内同项目实验串行；不提供 git worktree、容器、文件权限隔离、IDA/调试器快照，也不自动把 patch 合并回主线。其他进程仍可能修改同一个项目。
2. **worker 是受信协作者。** 工具门禁阻止其使用 Board/knowledge/handoff、quest 和常见委派工具；它仍能通过通用文件/命令工具访问文件。自定义别名工具不在该门禁的完整识别范围内。应通过 `workerPreset` 配置所需工具范围。
3. **语义重复无法由 hash 完全识别。** route / method / 证据版本 / contract 决定尝试指纹；报告带假设和区分性实验供下次参考。换了措辞但同一个错误假设，仍可能被当成新尝试。没有声称实现自动语义穷举。
4. **默认方法是起点。** v0.1 内置 forward / backward / minimize / falsify，可选择顺序；新增领域方法需要扩展 `METHODS` 并验证效果。它们不等价于神经专家。
5. **崩溃不自动重跑。** 未知 child 状态、遗留 `runner.lock` 或损坏日志须先检查。没有自动强拆锁、接管其他 session 或恢复未知副作用的命令。
6. **新 worker 不继承对话，不等于没有系统注入。** 适配器滤掉本桥接插件的 `pi-harness` 被动 reference，阻止相关共享工具；其他 DSH 插件和项目说明仍由 preset 决定。
7. **准确性边界在验收器。** 固定错的验收器只会稳定地产生错结论；需要独立复现、阴性对照和任务针对性的验证设计。

详细推理与后续演进见 [设计说明](docs/design.md)。
