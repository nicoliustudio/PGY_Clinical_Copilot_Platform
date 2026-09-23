# PGY Control Plane V2.1.1 — Actuation Closure Changelog

日期：2026-09-22

本版不重写 V2.1 Generic Resolver / backward-chaining planner，集中修复真实 E2E 暴露的 **graph → execution → durable state → result** 断层。

## 已实现

### 1. 多治疗形式 durable delivery

- `TreatmentPlan` 新增 `treatmentDeliveries?: TreatmentFormDecision[]`。
- 保留 `treatmentFormDecision` 作为兼容别名，避免一次性打碎旧调用方。
- Workspace 写入按 `outcome`（fallback: form）合并，后写入的 modality 不再覆盖先前 modality。
- delivery closure 按每个 payload 的 semantic outcome 独立归属；一个 delivery 最多关闭一个 obligation，多 delivery 可关闭多个 modality。

### 2. H12 与 V2.1 clinical-core 同一真源

- `checkClinicalCoreCompletion()` 把 unresolved formal hypothesis disposition 纳入 clinical-core truth。
- 因此存在未处置 alternative 时，`artifact:clinical-core` 不再提前 SATISFIED。
- `workspace.consider_hypotheses` 进入 V2.1 commit effect surface；clinical-core 完成后不允许再无条件创建 hypothesis 把旧 H12 重新打开。

### 3. Durable mutation 进入 Effect Surface

- `workspace.record_deliberation` 声明 clinical-core / formula-selection / treatment-delivery commit effects。
- tool execute 前再次按实际 payload 检查当前 admissible commit target，避免“多用途超级写工具”借一个 runnable effect 偷写未来 artifact。

### 4. Provider 确定性激活

- Request IR + graph 已选定的 provider 由 RuntimePreparer 自动 activate。
- compiled V2.1 action surface 关闭 `capability.discover` / `capability.activate`，消除 resolver 已知道 provider 后模型再次编排 provider 的重复循环。

### 5. treatment evidence discovery / hydration 收敛

- 多 treatment capability 时，一次只围绕一个稳定 runnable treatment-evidence obligation 检索。
- `knowledge.search_cards` receipt 只记入当前 obligation 的 scopes，避免 global top-K 把其他 capability 错记为 SEARCHED_NONE。
- discovery 没产生 asset 时不开放 `knowledge.get_asset`；一旦发现待 hydrate asset，就关闭重复 `knowledge.search_cards`。
- `knowledge.get_asset` 同样限制到当前 treatment-evidence obligation scopes。

### 6. formula discovery / hydration 收敛

- 没有 formula candidate：开放 discovery、关闭 hydrate/validate。
- 已产生 formula candidate：关闭重复 candidate discovery，推进到 evidence hydration/validation。

### 7. 未知显式 modality fail-closed

- Request IR 新增 `outcomes.unresolved`。
- compiler 明确禁止把 registry 中不存在的显式治疗形式映射成“最近”的已有 modality。
- Planner 将 unresolved request 变成 typed `UNSUPPORTED_OUTCOME` blocker。

### 8. Deterministic user result 补齐多结果

- `ClinicalResult` 新增 `treatment_deliveries` 与 `formula_set`。
- 两者由 durable Workspace / sourceFormulaSet 确定性投影，不让模型最终再自由总结而 silent drop。
- `AT_LEAST N` 若 deterministic formula set 数量不足，结果必须显式写 cardinality shortfall。

### 9. Source ZIP 自包含修复

原 V2.1 Source ZIP 的 `scripts/control-plane-v2-check.mjs` / `control-plane-v21-check.mjs` 引用了未打包的 `reference/` 目录。本版改为运行仓库内 canonical tests，不再依赖缺失目录。

## 新增/更新的回归不变量

`tests/control-plane-v21-integration.test.ts` 增加覆盖：

- provider 自动激活，discover/activate 不再暴露；
- treatment discovery → hydration 单向推进；
- 针灸 + 膏方两个 durable deliveries 独立 closure；
- formula candidate 出现后关闭重复 discovery；
- H12 unresolved alternative 阻止 clinical-core / graph 提前 complete；
- unknown explicit modality 产生 typed unsupported。

## 刻意没有伪装成“已彻底完成”的两点

1. **MODEL_ALLOWED**：本版修复了结果层的诚实表达，但尚未把 model-authored generation 建模为独立通用 provider/effect/obligation。下一步若做，应做 generic generation provider，不能写 herbal-formula 特判。
2. **Formula cardinality**：本版把 `formula_set` 与 shortfall 做成 deterministic postcondition；尚未把 `AT_LEAST N` 变成 graph-level cardinality obligation。真实 E2E 必须验证是否需要继续提升到 graph postcondition。

因此本版定位是 **V2.1.1 Actuation Closure**，不是宣称所有长期技术债已经清零。
