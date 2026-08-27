// ==========================================
// Media Root Controller Module (Issue #19 SSOT Media Root Selector)
// ==========================================
import { loadVideoList } from './controller-app.js';

export async function fetchCurrentMediaRoot() {
  try {
    const res = await fetch('/api/media-root');
    const data = await res.json();
    updateMediaRootUI(data);
  } catch (err) {
    showMediaRootStatus('Failed to load media root: ' + err.message, true);
  }
}

export function updateMediaRootUI(data) {
  const inp = document.getElementById('inpMediaRoot');
  const txtCur = document.getElementById('txtCurrentMediaRoot');
  const txtCount = document.getElementById('txtMediaRootCount');
  const statusEl = document.getElementById('txtMediaRootStatus');

  if (inp && data.root && !inp.dataset.userEditing) {
    inp.value = data.root;
  }
  if (txtCur) {
    txtCur.textContent = data.root || '--';
  }
  if (txtCount) {
    txtCount.textContent = (typeof data.videoCount === 'number') ? (data.videoCount + ' videos') : '--';
  }
  if (statusEl && !statusEl.dataset.customError) {
    statusEl.textContent = 'Active';
    statusEl.style.color = '#34d399';
  }
}

export function showMediaRootStatus(msg, isError = false) {
  const statusEl = document.getElementById('txtMediaRootStatus');
  if (!statusEl) return;
  statusEl.textContent = msg;
  statusEl.style.color = isError ? '#f87171' : '#34d399';
  statusEl.dataset.customError = isError ? 'true' : '';
  if (!isError) {
    setTimeout(() => {
      delete statusEl.dataset.customError;
    }, 4000);
  }
}

export async function applyMediaRoot() {
  const inp = document.getElementById('inpMediaRoot');
  const btn = document.getElementById('btnApplyMediaRoot');
  if (!inp) return;
  const newPath = inp.value.trim();
  if (!newPath) {
    showMediaRootStatus('Please enter an absolute folder path', true);
    return;
  }

  if (btn) {
    btn.disabled = true;
    btn.textContent = 'Scanning...';
  }

  try {
    const res = await fetch('/api/media-root', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ root: newPath })
    });
    const data = await res.json();
    if (!res.ok || data.error) {
      showMediaRootStatus(data.error || 'Failed to switch media root', true);
    } else {
      showMediaRootStatus('✓ Updated (' + data.videoCount + ' videos found)', false);
      inp.dataset.userEditing = '';
      updateMediaRootUI(data);
      await loadVideoList();
    }
  } catch (err) {
    showMediaRootStatus('Network error: ' + err.message, true);
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = 'Apply & Rescan';
    }
  }
}

export function initMediaRootController() {
  const inp = document.getElementById('inpMediaRoot');
  if (inp) {
    inp.addEventListener('input', () => {
      inp.dataset.userEditing = 'true';
    });
    inp.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        applyMediaRoot();
      }
    });
  }
  fetchCurrentMediaRoot();
}

window.applyMediaRoot = applyMediaRoot;