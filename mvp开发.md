# 蒲公英 Clinical Copilot V1

## 第一性 MVP 开发与验收基线

### 1. V1 唯一目标

V1 暂时不以“搭完临床智能平台”为目标。

V1 只验证一件事：

**医生输入一段患者主诉后，系统能够通过 AI SDK 驱动的 Clinical Agent 理解病例，调用真实知识库，在允许使用的知识范围内召回正确证据和方剂，并输出可追溯的病名、辨证、治法、方剂及依据。**

第一性主链固定为：

```text
医生主诉
   ↓
病例事实理解
   ↓
Clinical Primary Agent
   ↓
知识检索
   ↓
证据判断
   ↓
病名 / 证型 / 治法假设
   ↓
规范方检索
   ↓
方剂 Authority 判断
   ↓
结果 + 来源 + Trace
```

这里保留原架构中非常重要的一条原则：

**“病 → 证 → 法 → 方”是最终临床结果的展示结构，而不是四个固定 Engine 串联。**

原开发文档已经明确，新的内部运行方式应从统一 Fact/Observation 出发，再形成 hypothesis、strategy 和 formula proposal，而不是重新做 Disease Engine → Syndrome Engine → Formula Engine。

---

# 2. V1 必须开发的内容

| P0模块                           | V1实际开发内容                                                                                     | 第一波验收标准                                                                                             |
| ------------------------------ | -------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| **模型配置层**                      | 基于 AI SDK 7 建立统一 `ModelAdapter`。支持 `baseURL / apiKey / model / reasoning` 配置，不把具体厂商写死在业务代码中。 | 用户修改 `.env` 或配置文件即可切换模型；不修改业务代码；启动后 `/health/model` 能完成真实模型探针。                                      |
| **Clinical Primary Agent**     | 第一版只保留 **1 个 Agent**。用 AI SDK `ToolLoopAgent` 承担病例理解、检索决策和结果综合。                              | 一个主诉可以产生完整 Run；工具调用过程可观察；不存在 DiseaseAgent、SyndromeAgent、FormulaAgent。                               |
| **主诉结构化**                      | 将自然语言解析为最小 Clinical Snapshot：人口学信息、主诉、症状、时序、舌脉、检查、既往诊断、既往治疗。                                 | `debug_microset_12` 全部可以成功解析、不崩溃；主诉 gold 可以单独运行结构化评测。                                               |
| **Runtime Knowledge Registry** | 只把明确允许 Runtime 使用的知识装载进运行环境。P1、来源、authority、runtime_allowed 必须可识别。                           | Runtime 索引中 `evaluation` 数据数量必须为 **0**；Shadow-only V3.5 不得自动获得处方权威；所有索引条目均能追溯 source。               |
| **knowledge.search**           | 第一版只暴露一个高内聚检索 Tool。内部可实现 lexical + dense + rerank + source fallback。                         | 输入病例后返回结构化 Top-K：`source_id / title / authority / excerpt / score / provenance`；不得只返回一段模型生成的“知识总结”。 |
| **formula.search_normative**   | 在已经形成的病例问题/治法方向下检索规范方。                                                                       | 命中时必须返回真正的 `formula_id/source_id/composition`；不得由模型重新凭记忆生成“看起来一样”的方子。                               |
| **Formula Authority**          | 第一版只需要实现 `NORMATIVE / GENERATED_DRAFT / BLOCKED` 三态。                                         | 有 P1 明确方时走 `NORMATIVE`；无直接权威方时不能伪装成规范方；任何结果必须知道自己属于哪一种 Authority。                                   |
| **最小 Safety Gate**             | 不做完整临床安全平台，但保留红旗/系统完整性最低门槛。                                                                  | Safety 被 BLOCK 时不得继续产生 `NORMATIVE` 方剂结果；测试报告中能看到被什么 Gate 阻断。                                        |
| **Run Trace**                  | 保存整个一次 Run 的模型、Prompt version、Tool Call、搜索词、Top-K、最终 source/formula、耗时、token、错误。             | 任意测试病例都能够打开 Trace 回答：“模型为什么选了这个方？”                                                                  |
| **Eval Runner**                | 第一版就实现批量跑测，而不是等 Eval Center。                                                                 | 一条命令可以分别运行 debug、calibration、holdout、external regression，并生成 JSON + HTML/Markdown 报告。               |
| **最小医生 UI**                    | 在现有 UI Shell 上只接通“输入病例→流式运行→结果卡→Evidence/Trace”。                                             | 本地浏览器输入真实病例，可以看到病名、证型、治法、方剂、来源和 Trace；不是只能通过 Postman 测试。                                            |

---

# 3. V1 Agent 只给四个核心工具

原架构设计了约 14～16 个 Tool，包括 identity、history、fact delta、cases、HITL 等。

这些最终都可能需要，但**第一性 MVP 不需要一次完成。**

V1 Agent 只开放：

```text
clinical.extract
knowledge.search
formula.search_normative
formula.validate
```

其中：

```text
clinical.extract
```

负责把病例输入转成统一 Clinical Snapshot。

```text
knowledge.search
```

负责病、证、治法相关证据检索。

```text
formula.search_normative
```

只负责查知识库已有规范方。

```text
formula.validate
```

负责确保最终引用的方剂确实存在、组成没有被模型偷偷篡改。

V1 暂时不要把：

```text
lexical.search
vector.search
reranker.search
source.search
```

分别暴露给 Agent。

这些都应该封装在 `knowledge.search` 内部。

Agent 决定“我要检索什么”，检索系统决定“怎样检索最好”。

---

# 4. V1 输出契约

每一个病例最终必须得到机器可评测的结构，而不仅仅是一段 Markdown：

```json
{
  "status": "COMPLETED",
  "clinical_snapshot": {},
  "disease": {
    "name": "",
    "confidence": 0,
    "evidence_refs": []
  },
  "syndrome": {
    "name": "",
    "confidence": 0,
    "evidence_refs": []
  },
  "treatment": {
    "text": "",
    "evidence_refs": []
  },
  "formula": {
    "authority": "NORMATIVE",
    "formula_id": "",
    "name": "",
    "composition": [],
    "source_id": "",
    "evidence_refs": []
  },
  "missing_information": [],
  "safety": {
    "status": "PASS"
  },
  "run_id": ""
}
```

这里尤其要坚持：

```text
AI Answer ≠ Clinical State
FormulaProposal ≠ Prescription
```

第一版输出的是临床辅助 Proposal，不做处方落库。

---

# 5. 知识库隔离是 V1 的硬门槛

当前资产已经明确：

**P1 是唯一处方权威；P2 只能作为观察性材料；S1/AUX 不允许直接开方；evaluation/replay 不允许参与运行时学习。**

因此第一版索引构建器必须明确区分：

```text
RUNTIME
SHADOW
EVALUATION_ONLY
```

特别是：

```text
assets/data/regression/*
assets/data/external_regression/*
assets/data/s1/*gold*
knowledge release 中用于 gold/eval 的资产
```

不能进入 Agent Runtime Retrieval。

否则测试用例实际上已经进入知识库，任何分数都会失去意义。

V3.5 也必须继续尊重其 Shadow 状态，而不能因为它是“最新版本”就自动变成处方权威。原架构对此已有明确约束。

---

# 6. 第一轮测试必须和开发同步完成

V1 不再按照：

```text
开发
→ 开发
→ 开发
→ 第三轮才开始 Eval
```

而改成：

```text
Vertical Slice
      ↓
接真实模型
      ↓
12例 Debug
      ↓
修 Runtime Bug
      ↓
40例 Calibration
      ↓
冻结 Prompt / Retrieval 参数
      ↓
113例 Holdout
      ↓
V2512 External Regression
      ↓
对比历史 Baseline
```

现有 clean base 已经包含 regression、holdout、calibration、S1 主诉 gold 和 external regression，因此不需要重新创造第一套测试资产。

其中数据使用原则固定为：

```text
debug_microset_12
→ 开发调试

calibration_40
→ Prompt / Retrieval / threshold 调整

holdout_113
→ 冻结后评测，禁止针对单例修改

external regression / V2512
→ 最终外部回归
```

---

# 7. V1 效果验收标准

V1 不应该在开发前凭感觉指定一个“90%准确率”。

最合理的标准是：

### Gate A：系统完整性

必须全部通过：

```text
模型可配置
Agent 可运行
Tool 可调用
知识可检索
Formula 可验证
Source 可追溯
Trace 可查看
Eval 可批量执行
```

任何一项缺失，V1 均不验收。

### Gate B：数据完整性

必须达到：

```text
Evaluation 数据进入 Runtime Index = 0
Shadow-only 知识获得 Runtime Authority = 0
NORMATIVE 方剂无 source_id = 0
NORMATIVE 方剂被模型私自改写 = 0
无法说明来源的最终规范方 = 0
```

这是比模型准确率更优先的验收项。

### Gate C：运行稳定性

`debug_microset_12`：

```text
12 / 12 完整跑完
无 Crash
无 Schema Error
无 Tool Loop 死循环
无空白最终状态
```

每个 Case 最终必须落到：

```text
NORMATIVE
GENERATED_DRAFT
BLOCKED
```

之一。

不允许出现“系统不知道发生了什么”。

### Gate D：临床效果

第一次冻结版直接与旧系统保存的 Baseline 对比。

重点比较：

```text
Disease final
Disease Recall@K
Syndrome final
Syndrome Recall@K
Formula Recall@3
Formula final
```

第一版硬性要求：

**不能因为换 AI SDK 和新 Runtime 而整体退化。**

更重要的是观察：

```text
Formula Recall@3
Formula Final
错误来源
错误检索
错误综合
```

因为整个 MVP 的第一性目标不是“聊天体验更好”，而是：

> **从主诉得到正确知识和正确方子的能力是否提高。**

因此第一轮报告必须同时给出：

```text
旧 Baseline
新 MVP
Delta
```

而不能只报告新系统自己的分数。

---

# 8. 每一个失败病例必须能回答“错在哪一层”

测试报告不能只写：

```text
case 17 = 错误
```

至少拆成：

```text
INPUT_PARSE_ERROR
FACT_EXTRACTION_ERROR
RETRIEVAL_MISS
RETRIEVAL_RANKING_ERROR
DISEASE_REASONING_ERROR
SYNDROME_REASONING_ERROR
TREATMENT_ERROR
FORMULA_RETRIEVAL_MISS
FORMULA_AUTHORITY_ERROR
FORMULA_MUTATION_ERROR
SAFETY_BLOCK
MODEL_OUTPUT_SCHEMA_ERROR
```

这样第一轮跑完以后，我们就知道：

到底是模型不行，

还是知识检索不行，

还是知识本身没有，

还是 Agent 没有调用正确 Tool，

还是最终综合阶段把正确证据用错了。

这才真正能够评估 **AI SDK 给 Runtime 带来的价值**。

---

# 9. 第一版明确不开发的东西

以下能力不是不要，而是**不允许阻塞第一性 MVP**：

| 延后能力                    | 原因                                         |
| ----------------------- | ------------------------------------------ |
| 完整多租户 SaaS              | 与“主诉→方剂”核心效果无直接关系                          |
| 完整 Patient Identity     | V1 测试病例可以使用独立 Encounter                    |
| Longitudinal Memory     | 第一轮先验证单诊次                                  |
| 多 Agent / Subagent      | 目前没有证据证明需要                                 |
| Capability Pack 管理后台    | 先证明主 Runtime 正确，再配置化                       |
| Policy DSL              | 第二阶段                                       |
| MCP                     | 当前知识库全部本地即可完成核心闭环                          |
| HIS/LIS/PACS            | 与模型效果验证无关                                  |
| Voice Realtime          | 第二阶段接入；AI SDK 7 已提供 realtime 能力，但无需影响第一轮验收 |
| WorkflowAgent           | 当前单次 Run 不需要 durable workflow              |
| Shadow / Canary 发布系统    | 先用文件版本冻结                                   |
| 完整 Doctor HITL          | V1 只保留结果“确认/不确认”占位                         |
| 完整 Admin Control Center | 第一轮用配置文件即可                                 |
| OTel 完整生产观测             | V1 用 Run Trace 足够                          |
| Legacy DB Migration     | 不影响第一性验证                                   |

换句话说：

**不要为了以后能跑 100 分，导致现在连 1 分都无法真实测试。**

---

# 10. V1 最小代码边界

第一版代码库甚至可以先压缩为：

```text
pgy-clinical-mvp/
│
├── apps/
│   └── web/
│
├── runtime/
│   ├── agent/
│   ├── model/
│   ├── tools/
│   └── trace/
│
├── clinical/
│   ├── extraction/
│   ├── safety/
│   └── formula-authority/
│
├── knowledge/
│   ├── registry/
│   ├── indexing/
│   └── retrieval/
│
├── contracts/
│
├── evals/
│   ├── runner/
│   ├── metrics/
│   └── reports/
│
└── docker-compose.yml
```

先不要为了最终平台形态把代码拆成二十几个 package。

但是两个边界必须从第一天存在：

```text
Agent Runtime
        ↓ Tool Contract
Clinical / Knowledge
```

以及：

```text
AI SDK Adapter
≠
Clinical Business Logic
```

AI SDK 是 Runtime 实现，而不是临床业务本身。

---

# 11. 本地交付的最终验收动作

第一波开发完成以后，你拿到代码，只应该需要：

```bash
cp .env.example .env
```

填入：

```text
MODEL_PROVIDER=
MODEL_BASE_URL=
MODEL_API_KEY=
MODEL_NAME=
EMBEDDING_MODEL=
```

然后：

```bash
docker compose up
```

进入浏览器。

输入一条真实病例。

系统完成：

```text
病例理解
→ Tool 调用
→ Knowledge Retrieval
→ Formula Retrieval
→ Source Binding
→ 最终结果
```

随后你还可以直接执行：

```bash
pnpm eval:debug
pnpm eval:calibration
pnpm eval:holdout
pnpm eval:external
```

得到：

```text
reports/
  latest/
    summary.html
    metrics.json
    failures.json
    traces/
```

**做到这里，我才认为第一波开发完成。**

不是后台页面做了多少个，

不是 Agent Studio 看起来多先进，

也不是架构图画得多完整。

而是：

> **你本地换上自己的真实模型以后，立即能够把你已有的测试用例全部跑起来，并且知道系统在哪些病例上比以前好、哪些变差、为什么变差。**

这才应该是蒲公英新 Runtime 的第一个里程碑。
