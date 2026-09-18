'use strict';

/* 语音实时流式输入：浏览器录音 → PCM 16kHz → /ws/asr → 服务端转写回传 */
(function () {
  const inputEl = document.getElementById('input');
  const micBtn = document.getElementById('mic');

  let audioCtx = null;
  let scriptNode = null;
  let source = null;
  let stream = null;
  let ws = null;
  let active = false;
  let baseText = '';
  let finalText = '';

  function downsample(buffer, fromRate, toRate) {
    const ratio = fromRate / toRate;
    const newLen = Math.round(buffer.length / ratio);
    const result = new Float32Array(newLen);
    let offsetResult = 0;
    let offsetBuffer = 0;
    while (offsetResult < newLen) {
      const nextOffset = Math.round((offsetResult + 1) * ratio);
      let accum = 0;
      let count = 0;
      for (let i = offsetBuffer; i < nextOffset && i < buffer.length; i++) {
        accum += buffer[i];
        count++;
      }
      result[offsetResult] = count ? accum / count : 0;
      offsetResult++;
      offsetBuffer = nextOffset;
    }
    return result;
  }

  function floatTo16BitPCM(float32) {
    const out = new Int16Array(float32.length);
    for (let i = 0; i < float32.length; i++) {
      const s = Math.max(-1, Math.min(1, float32[i]));
      out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
    }
    return out.buffer;
  }

  async function start() {
    if (active) return;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
      });
    } catch (e) {
      toast('无法访问麦克风：' + (e?.message || '权限被拒绝'));
      return;
    }

    baseText = inputEl.value;
    finalText = '';
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    source = audioCtx.createMediaStreamSource(stream);
    scriptNode = audioCtx.createScriptProcessor(4096, 1, 1);

    const proto = location.protocol === 'https:' ? 'wss://' : 'ws://';
    ws = new WebSocket(proto + location.host + '/ws/asr');
    ws.binaryType = 'arraybuffer';

    ws.onopen = () => { micBtn.classList.add('active'); active = true; };
    ws.onmessage = (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      if (msg.type === 'transcript' && msg.text) {
        finalText += msg.text;
        inputEl.value = baseText + finalText;
        inputEl.dispatchEvent(new Event('input'));
      } else if (msg.type === 'error') {
        toast(msg.message || '语音识别失败');
      }
    };
    ws.onerror = () => toast('语音服务连接失败');
    ws.onclose = () => { if (active) teardown(); };

    scriptNode.onaudioprocess = (e) => {
      const pcm = downsample(e.inputBuffer.getChannelData(0), audioCtx.sampleRate, 16000);
      if (ws && ws.readyState === WebSocket.OPEN) ws.send(floatTo16BitPCM(pcm));
    };
    source.connect(scriptNode);
    scriptNode.connect(audioCtx.destination);
  }

  function stop() {
    if (!active) return;
    active = false;
    micBtn.classList.remove('active');
    try { if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'end' })); } catch { /* noop */ }
    setTimeout(teardown, 250);
  }

  function teardown() {
    try { scriptNode?.disconnect(); } catch { /* noop */ }
    try { source?.disconnect(); } catch { /* noop */ }
    try { stream?.getTracks().forEach((t) => t.stop()); } catch { /* noop */ }
    try { audioCtx?.close(); } catch { /* noop */ }
    try { ws?.close(); } catch { /* noop */ }
    micBtn.classList.remove('active');
    active = false;
  }

  micBtn.addEventListener('click', () => {
    if (active) stop();
    else start();
  });
})();
