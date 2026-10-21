# 验证记录

日期：2026-10-21。

- `npm test`：25 项通过。覆盖停滞后换方法/模型、新证据保留当前路线、模型自称成功仍被验收拒绝、baseline 已满足、网络/执行失败、验收 pin 改变、无证据的正面判词、验收器超时、证书损坏、依赖版本失效、运行中依赖改变、环检测、项目内互斥、取消释放、损坏日志、路径逃逸、大 capsule 引用、会话模型清单、caller-only 交付、Board 注入过滤、worker 委派门禁、goal 阻塞、可选副本和跨副本共享预算。
- `npm run demo`：模拟模型尝试依次为 `flash/forward`、`flash/backward`、`alternative/forward`，由真实本地子进程验收后产生 accepted 证书。没有真实模型调用。
- `npm pack --dry-run`：通过，ESM bundle 包含入口、core、CLI、配置、文档和示例；无第三方运行时依赖。
- `git diff --check`：检查交付变更的空白。

未执行：真实 DSH plugin_manager 安装、真实 DSH 生命周期测试、DeepSeek/GLM API 测试、不同操作系统的进程树终止验证。当前运行环境没有 `dsh` 可执行程序。

本地测试支持“这些状态转换和接口调用在替身环境中符合设计”的结论，不支持“已在你的运行环境中解决实际安全分析任务”或“该路由优于固定模型”的结论。后者需要设计说明中的受控历史任务评测。
