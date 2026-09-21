'use strict';

const $ = (sel) => document.querySelector(sel);

function showError(message) {
  const box = $('#loginError');
  box.textContent = message;
  box.classList.remove('hidden');
}

async function submit(event) {
  event.preventDefault();
  const button = $('#loginSubmit');
  button.disabled = true;
  $('#loginError').classList.add('hidden');

  try {
    const res = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ loginName: $('#loginName').value.trim(), password: $('#password').value }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      showError(data.detail || `登录失败（HTTP ${res.status}）`);
      return;
    }
    window.location.replace('/');
  } catch (e) {
    showError(`网络异常：${e instanceof Error ? e.message : String(e)}`);
  } finally {
    button.disabled = false;
  }
}

// 已登录（会话仍有效）时直接回到工作台，避免重复登录。
fetch('/api/auth/me')
  .then((res) => { if (res.ok) window.location.replace('/'); })
  .catch(() => { /* 忽略：停留在登录页 */ });

$('#loginForm').addEventListener('submit', submit);
