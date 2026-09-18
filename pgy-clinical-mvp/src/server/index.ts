import { startServer } from './http.js';

const port = Number(process.env.APP_PORT ?? 8787);

startServer(port)
  .then((server) => {
    console.log(`[pgy] Clinical Copilot UI 已启动：http://localhost:${port}`);
    console.log(`[pgy] 语音 ASR：${process.env.ASR_ENABLED === 'true' ? '已配置' : '未配置'}`);
    server.on('error', (e) => console.error('[pgy] server error', e));
  })
  .catch((e) => {
    console.error('[pgy] 启动失败：', e instanceof Error ? e.message : e);
    process.exit(1);
  });
