// 容器健康检查：命中容器内就绪端点（/api/health 免登录）。
const port = process.env.APP_PORT || 8787;
try {
  const res = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(3000) });
  if (!res.ok) {
    console.error(`[healthcheck] HTTP ${res.status}`);
    process.exit(1);
  }
  const body = await res.json();
  if (!body.knowledge?.ok) {
    console.error(`[healthcheck] 知识库未就绪：${body.knowledge?.error ?? 'unknown'}`);
    process.exit(1);
  }
  process.exit(0);
} catch (e) {
  console.error(`[healthcheck] 探测失败：${e instanceof Error ? e.message : e}`);
  process.exit(1);
}
