# MioProxy AGENTS.md

## Repository expectations
- 使用 pnpm。
- 前端代码在 `src/renderer`，主进程代码在 `src/main`。
- 所有配置流水线代码放在 `packages/config-pipeline`。
- 所有核心管理代码放在 `packages/core-runtime`。
- 新增功能必须包含单元测试。
- 不允许直接修改 `active.yaml`；只能通过 render pipeline 生成。
- 所有外部控制器请求必须带 Bearer secret。
- 默认禁止把 controller 绑定到 0.0.0.0。
- Smart 相关逻辑默认视为兼容降级，不允许默认启用实验内核。

## Build/Test/Lint
- `pnpm install`
- `pnpm lint`
- `pnpm test`
- `pnpm build`

## Done when
- 类型检查通过
- 相关测试通过
- 关键错误路径有回滚逻辑
- 更新 README 或 docs 中的接口说明
