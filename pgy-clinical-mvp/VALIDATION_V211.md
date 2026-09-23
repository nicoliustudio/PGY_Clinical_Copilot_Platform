# PGY Control Plane V2.1.1 — Validation Notes

日期：2026-09-22

## 本环境实际完成的验证

- 对整个工程 **228 个 TS/TSX 文件**使用 TypeScript parser 做语法扫描：PASS（0 parse diagnostics）。
- 对修改版与原 V2.1 Source 做 TypeScript diagnostics 对比：在当前环境缺少第三方依赖类型的前提下，修复本次新增的本地类型错误后，**没有出现相对于 baseline 新增的非依赖类 diagnostics**。
- `scripts/control-plane-v2-check.mjs` 与 `scripts/control-plane-v21-check.mjs` 使用 `node --check`：PASS。
- 对 dependency-pure 的核心修改模块（workspace / capability-delivery / V2.1 planner）做独立严格 TypeScript 编译：PASS。
- 运行独立 closure smoke：H12 alternative 未处置时 clinical-core 不完成；处置后完成；两个 typed treatment deliveries 可独立产生两个 DELIVERED closure：PASS。
- 运行 unknown-modality blocker smoke：`outcomes.unresolved=["拔罐"]` 产生 `UNSUPPORTED_OUTCOME`：PASS。
- 手工/静态核对 planner 未加入 acupuncture / gaofang / formula 等新的业务分支；V2.1 generic planner 保持不被本轮 actuation 修复侵入。

## 本环境无法完成的验证

上传的 Source ZIP 不含 `node_modules`。尝试 `npm ci` 时，当前运行环境无法解析/访问 npm registry（`EAI_AGAIN`）；因此不能诚实声称以下命令已在本环境重新 PASS：

```bash
npm run typecheck
npm test
npm run arch:test
npm run control:v2:check
npm run control:v21:check
npm run control:v211:check
```

此外原 Source ZIP 中两个 control check 脚本引用了未打包的 `reference/` 目录，本版已经修复为仓库内自包含测试入口。

## Trae / 真实工程环境必须执行

按 `TRAE_EXECUTION_V211.md` 先执行全量命令，再跑原 5 个真实 E2E。特别不能只看 graphComplete；必须同时看最终 runtime status、outcomeCoverage、readiness、tool sequence 和 deterministic result。
