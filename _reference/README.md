# `_reference/` —— 外部专家参考包（只读）

本目录用于存放**其他专家修改后的核心文件（含其自带的 `src/`）**，仅供人工对照参考。

> ⚠️ **一句话纪律：这里是"进来参考的"，不是"项目源码"，也永远不会参与构建。**

---

## 1. 为什么单独建这个目录

仓库里三个目录的职责必须互不混淆：

| 目录 | 方向 | 用途 |
| --- | --- | --- |
| `pgy-clinical-mvp/src` | — | **唯一真实源码**。运行时/测试/typecheck 只认这里 |
| `exports/` | 出去 | **对外交付物**（打包给专家看的 ZIP 等） |
| `_reference/`（本目录） | 进来 | **外部专家给的参考包**，只读，不编译、不 import |

历史上曾把参考包解压在 `exports/*/_extracted/*/reference-implementation/src`，
结果与主 `src` 形成"**第二真源**"，难以判断哪份才是真实运行代码。本目录就是为了杜绝这件事。

---

## 2. 目录与命名规范

```
_reference/
  <来源>__<主题>__<YYYY-MM-DD>/
    _PROVENANCE.md     ← 必填：来源 / 日期 / 用途 / 对照的 commit
    original.zip       ← 可选：原始压缩包原样留存（便于追溯）
    extracted/         ← 解压内容，允许它自带 src/（路径已天然隔离）
      src/...
```

命名用**双下划线**分隔、**带日期**，便于排序与追溯：

```
expertA__kernel-commit-boundary__2026-09-23
expertB__delivery-transaction-runtime__2026-09-24
```

### `_PROVENANCE.md` 模板

```markdown
- 来源：<专家/团队/渠道>
- 收到日期：YYYY-MM-DD
- 主题：<这次改动针对什么>
- 对应本仓基线：<commit hash，例：fed3a8a>
- 用途：<要对照哪些文件、解决什么问题>
- 备注：<已知差异 / 风险 / 是否已落地>
```

---

## 3. 六条纪律

| # | 纪律 | 机制 |
| --- | --- | --- |
| 1 | **绝不 import** | `pgy-clinical-mvp/src` 不得 import `_reference/**`；由 `npm run arch:test` 强制 |
| 2 | **绝不编译** | 不在 `pgy-clinical-mvp/tsconfig.json` 的 include（`src` / `tests` / `scripts`）内，天然隔离 |
| 3 | **只读** | 不修改解压内容；需要改动一律在 `pgy-clinical-mvp/src` 走正常提交 |
| 4 | **消费方式 = diff 对照，不覆盖** | 见下方命令；**禁止**把参考包的 `src` 直接拷进项目 |
| 5 | **落地必须走正常 commit** | 参考目录永不参与构建 / 测试 / 部署 |
| 6 | **用完可整体删** | 本目录内容已被 `.gitignore` 排除，删除不影响仓库 |

---

## 4. 怎么对照（不覆盖）

```bash
# 只看差异范围
git diff --no-index --stat pgy-clinical-mvp/src _reference/<pkg>/extracted/src

# 逐文件看差异
git diff --no-index pgy-clinical-mvp/src/platform/commit _reference/<pkg>/extracted/src/platform/commit
```

**正确流程**：先看清差异 → 判断是否采纳 → 在 `pgy-clinical-mvp/src` 手工落地 → 跑
`typecheck` / `npm test` / `arch:test` → 正常提交。
**错误做法**：`Copy-Item -Recurse` 覆盖，或让项目直接引用参考包路径。

---

## 5. 关于版本管理

- 本目录的**内容不入库**（`.gitignore` 已排除），只有本 `README.md` 入库 —— 约定要留给后来人，专家代码不入公开仓库。
- 因此：**删除本目录下任何内容都不可通过 git 恢复**，重要参考包请自行另存备份。
