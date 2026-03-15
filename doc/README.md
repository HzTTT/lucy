# Lucy 文档索引

当前文档按下面的优先级阅读：

## 1. 权威流程文档

- [auth-binding/integrated-flow.md](auth-binding/integrated-flow.md)
  - Lucy 当前绑定、鉴权、NATS 连接的统一主流程
- [auth-binding/user-center-integration.md](auth-binding/user-center-integration.md)
  - `user-center` 已落地接口与返回结构
- [app-nats-integration.md](app-nats-integration.md)
  - App / SDK 直接接入 Lucy NATS 协议时的权威边界

## 2. 运行与验证文档

- [../README.md](../README.md)
  - 仓库总览、当前推荐配置、探针方式、端到端验证命令
- [raw-event-sequences.md](raw-event-sequences.md)
  - 当前有效的 raw event 时序与观察结论

## 当前阅读顺序

如果你是第一次接手 Lucy，建议按这个顺序：

1. 先读 [../README.md](../README.md)
2. 再读 [auth-binding/integrated-flow.md](auth-binding/integrated-flow.md)
3. 如果你做 App/SDK，对照 [app-nats-integration.md](app-nats-integration.md)
4. 如果你做 `user-center` 或 `auth-callout`，再读 [auth-binding/user-center-integration.md](auth-binding/user-center-integration.md)
