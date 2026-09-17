# H1 Validation Record

## 已在交付环境实际执行

1. Architecture Guard（通过）
   - 使用 Node 22 built-in TypeScript stripping 执行 `scripts/check-architecture.ts`
   - 结果：`Architecture guard PASSED (5 capability markers protected).`

2. Structural TypeScript compilation（通过）
   - 容器 npm registry DNS 不可达，无法完成正常 `npm ci`。
   - 使用系统 TypeScript 5.8.3 + 外部依赖 ambient stubs 对完整 `src/tests/scripts` 做内部类型/语法编译检查。
   - 结果：0 errors。
   - 说明：该检查不能替代你本地使用 package-lock 中真实 AI SDK/Zod 类型执行的 `npm run typecheck`。

3. Structural tests（通过）
   - 将源码编译成 JS 后直接运行 Node test runner。
   - 结果：12/12 pass，0 fail。
   - 覆盖：Capability 动态激活、Skill/scope JIT、high+routine 不误阻断、urgent 阻断、Formula Authority、source/formula/composition 同源绑定、Trace runId 隔离。

## 交付后本地必须再跑

```powershell
cd pgy-clinical-mvp
npm install
npm run typecheck
npm test
npm run arch:test
```

由于私有 `assets/` 与真实模型凭据按约定未进入交付包，以下仍需在你的本地环境运行：

```powershell
npm run build:index
npm run eval:debug:harness
npm run eval:debug:classic
npm run eval:holdout:harness
npm run eval:holdout:classic
```

## A/B 重点观察

- syndrome / formula gold 命中
- search query 是否发生二次/三次变化
- `knowledge.get_source` 使用率
- Capability 激活轨迹
- Safety false positive / false negative
- `FORMULA_AUTHORITY_ERROR` 与 `SAFETY_BLOCK` 分离
- latency / token cost
- Authority violations 必须为 0
