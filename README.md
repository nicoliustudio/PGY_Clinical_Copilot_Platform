# PGY Clinical Copilot Platform

蒲公英中医临床智能平台 —— 从医生主诉到可溯源方剂建议的 AI 临床辅助系统。

## 定位

一个多租户、配置驱动、能力包驱动的中医临床智能平台。核心分界：

- **AI（开放世界）**：病例理解、假设、检索、规划与综合，输出永远是 Proposal。
- **Authority Kernel（封闭世界）**：身份、事实、安全、处方权威、医生确认与审计，AI 不可绕过。
- **Capability Pack**：可插拔的业务扩展单元（如妇科、膏方、儿科），靠声明式激活，不写死 if/else。

## 仓库结构

```
pgy-clinical-mvp/    MVP 代码（AI SDK 7 + TypeScript 单栈）
开发架构.md          目标态架构蓝图
mvp开发.md           第一性 MVP 开发与验收基线
```

## 关键原则

- 「病 → 证 → 法 → 方」是输出模型，不是四个固定 Engine 串联。
- `AI Answer ≠ Clinical State`，`FormulaProposal ≠ Prescription`。
- P1 是唯一处方权威；P2 仅观察性；evaluation/replay 不参与运行时学习。
- 知识资产（书籍原文、评测 gold、真实病例）私有管理，不进本公开仓库。

## MVP 快速开始

```powershell
cd pgy-clinical-mvp
npm install
cp .env.example .env   # 填入模型/embedding/rerank 配置
npm run build:index    # 构建知识索引（需本地知识资产）
npm run eval:debug     # 跑 12 例 debug 评测
```

详见 [pgy-clinical-mvp](pgy-clinical-mvp/) 与 [mvp开发.md](mvp开发.md)。
