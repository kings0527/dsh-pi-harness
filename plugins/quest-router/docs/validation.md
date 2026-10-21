# 验证记录

日期：2026-10-21。根 bundle 0.3.0；quest-router 0.2.0。

- 根目录 `npm test`：65 项，64 通过，1 跳过。原 translator 测试与全部 quest-router 测试进入同一个默认入口；跳过项需要真实 DSH 安装。
- 新增 24 项回归：goal 替换/编辑与执行中变化、旧目标成功结果不向新主线晋升、暂停恢复与预算保留、运行前错误阻塞、生命周期监听器异常隔离、路线交集、预检查超时、宿主委派深度、损坏日志隔离及保守计数、叶子/悬空符号链接、完整验收证据引用、CLI 未验证状态、大日志、真实后代进程超时清理、实验前登记/报告一致性/正文去重、自定义方法、重复观察自动副本、goal 自动入口、自动配置故障、完整 capsule 渐进读取、工具门禁、自动副本跨恢复去重，以及新证据保留同层有效路线。
- 原有 25 项插件测试继续覆盖 baseline、停滞切方法/模型、验收拒绝模型自评、外部故障、pin 变化、依赖 DAG、循环、证书撤销、串行锁、预算和上下文摘要。
- DSH 上游 `687f282e8625c6b8d11ff58211a90524be2e4317` 的 JSON Schema 校验器源码，经 Node 类型擦除运行，接受 quest / quest_context / quest_experiment 的输入输出及报告 schema；只替代了模块外部的错误类和 JSON 辅助依赖。这是协议子集检查，不是完整 DSH 生命周期测试。
- `npm run demo`：模拟模型依次为 flash/forward、flash/backward、alternative/forward；每次在工作区操作前登记实验，真实本地子进程验收后产生 accepted 证书。没有真实模型调用。
- 根包与独立子包 `npm pack --dry-run`：通过。根包包含插件、证书校验模块、配置 patch、文档、示例与回归测试，导出 `@local/dsh-pi-harness/quest-router`；无第三方运行时依赖。
- 实际构建并解包根 npm 包：自引用导出加载成功，patch、证书模块、测试辅助文件和回归测试都存在。
- `git diff --check`：通过。

未执行：真实 DSH plugin_manager 安装、完整 DSH 生命周期/模型流测试、DeepSeek/GLM API 测试、Windows taskkill 进程树终止验证。当前环境没有 dsh 可执行程序或上游依赖安装。

本地结果支持状态机、协议调用与 Linux 进程回收在所测条件下的正确性，不证明在用户安全分析任务中的成功率或成本优势。工作目录共享、非沙箱、领域验收器正确性与语义等价识别仍是设计中的明确边界。
