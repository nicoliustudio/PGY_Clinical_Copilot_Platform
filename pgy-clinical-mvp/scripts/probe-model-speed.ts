import 'dotenv/config';
import { generateText } from 'ai';
import { getModelCatalog, resolveLanguageModelFor, normalizeSelectionForOption } from '../src/model/model-registry.js';

const PROMPT = `你是中医临床助手。请对以下病例输出简要 JSON：{"disease":"...","syndrome":"...","treatment":"..."}。
患者女，30岁。经行腹痛拒按，经血色暗有块，块下痛减，舌质紫暗有瘀点，脉弦涩。`;

interface BenchResult {
  id: string;
  name: string;
  channel: string;
  thinkingMode: string;
  testThinking: boolean;
  status: 'SUCCESS' | 'FAILED';
  latencyMs?: number;
  outputTokens?: number;
  reasoningTokens?: number;
  error?: string;
  sample?: string;
}

async function runBenchmark() {
  const catalog = getModelCatalog();
  const results: BenchResult[] = [];

  console.log('================ 开始测试系统注册模型 ================');
  console.log(`候选模型总数: ${catalog.options.length}\n`);

  for (const opt of catalog.options) {
    if (!opt.available) {
      console.log(`[跳过] ${opt.id} - 通道未配置凭据`);
      continue;
    }

    // 测试模式：如果模型支持 toggle，测试关推理（以评估基线最快速度）和默认模式
    const testCases: { thinking: boolean; tag: string }[] = [];
    if (opt.thinking === 'toggle') {
      testCases.push({ thinking: false, tag: '关思考' });
      testCases.push({ thinking: true, tag: '开思考' });
    } else if (opt.thinking === 'always') {
      testCases.push({ thinking: true, tag: '总是思考' });
    } else {
      testCases.push({ thinking: false, tag: '非推理' });
    }

    for (const tc of testCases) {
      const selection = normalizeSelectionForOption(opt, { thinking: tc.thinking, budget: 'off' });
      const model = resolveLanguageModelFor(selection);
      const label = `${opt.id} [${tc.tag}]`;

      process.stdout.write(`测试中: ${label.padEnd(45)} ... `);
      const t0 = Date.now();
      try {
        // 设置超时限制，避免挂起
        const timeoutPromise = new Promise((_, reject) => 
          setTimeout(() => reject(new Error('请求超时 (>15s)')), 15000)
        );
        const reqPromise = generateText({
          model,
          prompt: PROMPT,
          maxOutputTokens: 120,
          temperature: 0.1,
        });

        const res = await Promise.race([reqPromise, timeoutPromise]) as Awaited<typeof reqPromise>;
        const latency = Date.now() - t0;
        const outTok = res.usage?.outputTokens ?? 0;
        // @ts-ignore
        const reasoningTok = res.usage?.reasoningTokens ?? 0;

        console.log(`成功 | ${latency}ms | out=${outTok} | reasoning=${reasoningTok}`);
        results.push({
          id: opt.id,
          name: opt.label,
          channel: opt.channelLabel,
          thinkingMode: opt.thinking,
          testThinking: tc.thinking,
          status: 'SUCCESS',
          latencyMs: latency,
          outputTokens: outTok,
          reasoningTokens: reasoningTok,
          sample: res.text.replace(/\n/g, ' ').slice(0, 60),
        });
      } catch (err: any) {
        const latency = Date.now() - t0;
        const errMsg = err?.message || String(err);
        console.log(`失败 (${latency}ms) | ${errMsg.slice(0, 80)}`);
        results.push({
          id: opt.id,
          name: opt.label,
          channel: opt.channelLabel,
          thinkingMode: opt.thinking,
          testThinking: tc.thinking,
          status: 'FAILED',
          latencyMs: latency,
          error: errMsg,
        });
      }
    }
  }

  console.log('\n================ 测试汇总报告 ================');
  console.log('| 通道 | 模型 | 思考模式 | 状态 | 耗时(ms) | 输出Tokens | 思考Tokens | 详情/错误 |');
  console.log('| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |');

  for (const r of results) {
    const thinkingTag = r.testThinking ? '开启' : '关闭';
    const statusTag = r.status === 'SUCCESS' ? '可用' : '不可用/崩溃';
    const latStr = r.latencyMs !== undefined ? `${r.latencyMs}` : '-';
    const outStr = r.outputTokens !== undefined ? `${r.outputTokens}` : '-';
    const rznStr = r.reasoningTokens !== undefined ? `${r.reasoningTokens}` : '-';
    const note = r.status === 'SUCCESS' ? (r.sample ?? '') : (r.error?.slice(0, 40) ?? '');
    console.log(`| ${r.channel} | ${r.name} | ${thinkingTag} | ${statusTag} | ${latStr} | ${outStr} | ${rznStr} | ${note} |`);
  }

  const successList = results.filter(r => r.status === 'SUCCESS' && r.latencyMs !== undefined);
  if (successList.length > 0) {
    successList.sort((a, b) => (a.latencyMs ?? 0) - (b.latencyMs ?? 0));
    console.log('\n================ 速度排行榜 (Top 5 可用模型) ================');
    successList.slice(0, 5).forEach((r, idx) => {
      console.log(`${idx + 1}. [${r.channel}] ${r.name} (${r.testThinking ? '开思考' : '关思考'}) -> 耗时: ${r.latencyMs}ms`);
    });
  }
}

runBenchmark().catch(err => {
  console.error('基准测试运行异常:', err);
});
