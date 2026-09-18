import { randomUUID } from 'node:crypto';
import type { WebSocket as BrowserSocket } from 'ws';
import { config } from '../config.js';

/**
 * DashScope 实时语音识别（百炼）WebSocket 中继。
 * 浏览器通过 /ws/asr 上传 PCM 音频帧，本模块负责注入 Authorization，
 * 把音频转发给 DashScope，并把识别结果实时回传。
 *
 * 协议（run-task / task-started / result-generated / finish-task）：
 * https://help.aliyun.com/zh/model-studio/fun-asr-realtime-websocket-api
 */

interface DashScopeMessage {
  header: { task_id?: string; event?: string; action?: string; error_message?: string };
  payload?: {
    output?: { sentence?: { text?: string } };
    usage?: unknown;
  };
}

export function isAsrEnabled(): boolean {
  return config.asr.enabled && Boolean(config.asr.wsUrl) && Boolean(config.asr.apiKey);
}

function runTask(taskId: string): Record<string, unknown> {
  return {
    header: { action: 'run-task', task_id: taskId, streaming: 'duplex' },
    payload: {
      task_group: 'audio',
      task: 'asr',
      function: 'recognition',
      model: config.asr.model,
      parameters: { format: 'pcm', sample_rate: config.asr.sampleRate },
      input: {},
    },
  };
}

function finishTask(taskId: string): Record<string, unknown> {
  return {
    header: { action: 'finish-task', task_id: taskId, streaming: 'duplex' },
    payload: { input: {} },
  };
}

/**
 * 把浏览器上传的 PCM 流中继到 DashScope ASR。
 * 浏览器侧约定：二进制消息 = PCM 帧；文本消息 { type: 'end' } = 结束听写。
 */
export function relayAsr(browser: BrowserSocket): void {
  if (!isAsrEnabled()) {
    browser.send(JSON.stringify({ type: 'error', message: 'ASR 未配置或未启用' }));
    browser.close();
    return;
  }

  const taskId = randomUUID().replace(/-/g, '');
  let upstream: globalThis.WebSocket | null = null;
  let started = false;
  let closed = false;

  const sendFinish = () => {
    if (upstream && upstream.readyState === globalThis.WebSocket.OPEN) {
      upstream.send(JSON.stringify(finishTask(taskId)));
    }
  };

  const teardown = () => {
    if (closed) return;
    closed = true;
    sendFinish();
    try {
      browser.close();
    } catch {
      /* ignore */
    }
  };

  upstream = new globalThis.WebSocket(config.asr.wsUrl, {
    headers: { Authorization: `Bearer ${config.asr.apiKey}` },
  });

  upstream.onopen = () => {
    upstream?.send(JSON.stringify(runTask(taskId)));
  };

  upstream.onmessage = (event) => {
    let msg: DashScopeMessage;
    try {
      msg = JSON.parse(String(event.data)) as DashScopeMessage;
    } catch {
      return;
    }
    const ev = msg.header?.event;
    if (ev === 'task-started') {
      started = true;
      browser.send(JSON.stringify({ type: 'ready' }));
    } else if (ev === 'result-generated') {
      const text = msg.payload?.output?.sentence?.text ?? '';
      if (text) browser.send(JSON.stringify({ type: 'transcript', text, final: true }));
    } else if (ev === 'task-failed') {
      browser.send(JSON.stringify({ type: 'error', message: msg.header?.error_message ?? 'ASR task failed' }));
      teardown();
    }
  };

  upstream.onerror = () => {
    browser.send(JSON.stringify({ type: 'error', message: 'ASR 连接失败' }));
    teardown();
  };

  upstream.onclose = () => {
    if (started) browser.send(JSON.stringify({ type: 'finished' }));
    teardown();
  };

  browser.on('message', (data, isBinary) => {
    if (isBinary) {
      if (started && upstream && upstream.readyState === globalThis.WebSocket.OPEN) {
        upstream.send(data as Buffer);
      }
      return;
    }
    // 文本控制消息
    let control: { type?: string } | null = null;
    try {
      control = JSON.parse(String(data)) as { type?: string };
    } catch {
      control = null;
    }
    if (control?.type === 'end') {
      sendFinish();
    }
  });

  browser.on('close', () => {
    teardown();
    upstream?.close();
  });

  browser.on('error', () => {
    teardown();
    upstream?.close();
  });
}
