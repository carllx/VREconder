// ==========================================
// Media Root Controller Module (Issue #19 SSOT Media Root Selector)
// ==========================================
import { loadVideoList } from './controller-app.js';

export async function parseJsonResponse(res) {
  const text = await res.text();
  const contentType = res.headers.get('content-type') || '';
  if (!contentType.includes('application/json') && !text.trim().startsWith('{')) {
    throw new Error('Server is outdated or not restarted. Please restart VREconder Server.');
  }
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new Error('Server returned invalid response: ' + text.slice(0, 100));
  }
}

export async function fetchCurrentMediaRoot() {
  try {
    const res = await fetch('/api/media-root');
    if (res.status === 404) {
      showMediaRootStatus('Server is outdated or not restarted. Restart VREconder Server.', true);
      return;
    }
    const data = await parseJsonResponse(res);
    updateMediaRootUI(data);
  } catch (err) {
    showMediaRootStatus(err.message || 'Failed to load media root', true);
  }
}

export function updateMediaRootUI(data) {
  if (!data) return;
  const inp = document.getElementById('inpMediaRoot');
  const txtCur = document.getElementById('txtCurrentMediaRoot');
  const txtCount = document.getElementById('txtMediaRootCount');
  const statusEl = document.getElementById('txtMediaRootStatus');

  if (inp && data.root && !inp.dataset.userEditing) {
    inp.value = data.root;
  }
  if (txtCur) {
    txtCur.textContent = data.root || '--';
    txtCur.title = data.root || '';
  }
  if (txtCount) {
    txtCount.textContent = (typeof data.videoCount === 'number') ? ('(' + data.videoCount + ' videos)') : '--';
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
      if (statusEl.textContent.startsWith('✓')) {
        statusEl.textContent = 'Active';
        statusEl.style.color = '#34d399';
      }
    }, 4000);
  }
}

export function toggleMediaRootEditor(forceState) {
  const panel = document.getElementById('mediaRootEditorPanel');
  const btn = document.getElementById('btnToggleMediaRootEditor');
  if (!panel) return;
  const isVisible = (typeof forceState === 'boolean') ? forceState : (panel.style.display !== 'none');
  panel.style.display = isVisible ? 'none' : 'block';
  if (btn) btn.textContent = isVisible ? 'Change' : 'Close';
  if (!isVisible) {
    const inp = document.getElementById('inpMediaRoot');
    if (inp) { inp.focus(); inp.select(); }
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
    if (res.status === 404) {
      showMediaRootStatus('Server is outdated or not restarted. Restart VREconder Server.', true);
      return;
    }
    const data = await parseJsonResponse(res);
    if (!res.ok || data.error) {
      showMediaRootStatus(data.error || 'Failed to switch media root', true);
    } else {
      showMediaRootStatus('✓ Updated (' + data.videoCount + ' videos found)', false);
      inp.dataset.userEditing = '';
      updateMediaRootUI(data);
      toggleMediaRootEditor(true);
      await loadVideoList();
    }
  } catch (err) {
    showMediaRootStatus(err.message || 'Network error', true);
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

if (typeof window !== 'undefined') {
  window.applyMediaRoot = applyMediaRoot;
  window.toggleMediaRootEditor = toggleMediaRootEditor;
}