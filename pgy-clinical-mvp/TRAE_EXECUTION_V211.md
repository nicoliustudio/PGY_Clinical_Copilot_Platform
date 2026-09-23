# PGY Control Plane V2.1.1 — Trae 执行指令

基于本目录源码继续工作。**不要重新设计 Planner，不要增加病例/针灸/膏方/拔罐等业务 if/else。** 本版目标是把 V2.1 已正确的 Obligation Graph 真正接到执行层。

## 你只需要做三件事

### 1. 先完整验证

```bash
npm ci
npm run typecheck
npm test
npm run arch:test
npm run control:v2:check
npm run control:v21:check
npm run control:v211:check
```

> 本源码包已修复原导出包中 `control:v2:check` / `control:v21:check` 仍引用未打包 `reference/` 目录的问题。

任何失败先修实现，不得通过降低 Safety/Authority、放宽 closure、增加 maxSteps 或加病例特判来过测。

### 2. 用原来的 5 个真实场景重新做同批 E2E

必须逐项核对：

1. **只针灸**：provider 由 V2.1 自动激活；不应再出现 capability.discover / capability.activate 循环；search_cards 后若已有资产必须进入 get_asset，不能继续重复 discovery。
2. **针灸 + 膏方**：Workspace 中必须同时存在两个 `treatmentDeliveries[]` 项，分别绑定 `modality:acupuncture` / `modality:gaofang`；两个 delivery obligation 必须独立 DELIVERED。
3. **多个方**：发现 formula candidate 后不能继续重复 `formula.search_candidates`；必须推进到 hydrate/selection。最终结果用 `formula_set` 投影；若 `AT_LEAST N` 实际不足 N，必须显式报告 cardinality shortfall，禁止假装满足。
4. **KB 不足 + MODEL_ALLOWED**：不要把“允许模型拟方”误映射成膏方。若没有 normative delivery，要明确区分 KB 交付与 model-authored advisory；本版尚未把 model-generation 做成独立 graph provider，若要继续完善，只能以通用 generation provider/effect 方式实现，不能加方剂特判。
5. **全新 modality**：若 registry 没有该 modality，Request IR 必须写入 `outcomes.unresolved` 并产生 typed `UNSUPPORTED_OUTCOME`；不得吸附到最近已有 modality。若要验证“manifest-only 扩展”，先真实新增对应 manifest/provider 再跑 E2E。

同时验证一个关键不变量：**只要存在未处置的 formal alternative hypothesis，`artifact:clinical-core` 就必须保持 OPEN；不得再出现 `graphComplete=true` 但 H12 readiness=false。**

### 3. 只处理真实环境差异，完成后给出证据

完成后输出：

- 全量测试结果；
- 5 场景原始 E2E JSON 路径；
- 每个场景的 Request IR、runnable obligation 序列、tool 序列、outcomeCoverage、readiness；
- 是否仍出现 capability discover/activate 重复；
- 是否仍出现 search→search / candidate-search→candidate-search 无状态推进；
- 是否仍出现 graphComplete 与 H12/readiness 不一致；
- `treatmentDeliveries[]` 和 `formula_set` 的最终用户结果截图/JSON；
- 剩余技术债。

## 不可破坏的原则

`用户表达 → Request IR → Generic Resolver → Obligation DAG → Runnable Obligation → Legal Effect Surface → Durable Artifact / Typed Blocker → Closure → Deterministic Result`

Runtime 决定“现在必须完成哪个义务、哪些动作能改变它”；模型只决定“如何完成当前合法义务”。
