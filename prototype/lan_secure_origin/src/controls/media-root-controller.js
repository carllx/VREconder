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

// Playback Timeline Scrubber Subsystem (Issue #19 / #14)
export let isScrubbing = false;
let scrubResumeTimeout = null;

export function formatTime(sec) {
  if (typeof sec !== 'number' || isNaN(sec) || sec < 0) return '0:00';
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${s < 10 ? '0' : ''}${s}`;
}

export function initTimelineScrubber(sendControlFn) {
  const scrubber = document.getElementById('timelineScrubber');
  if (!scrubber) return;

  const onScrubStart = () => {
    isScrubbing = true;
    if (scrubResumeTimeout) clearTimeout(scrubResumeTimeout);
  };

  const onScrubInput = (e) => {
    isScrubbing = true;
    const targetSec = parseFloat(e.target.value);
    const maxDur = parseFloat(scrubber.max) || 0;
    const elTime = document.getElementById('transportVideoTime');
    if (elTime) {
      elTime.textContent = `${formatTime(targetSec)} / ${maxDur > 0 ? formatTime(maxDur) : '--'}`;
    }
  };

  const onScrubCommit = (e) => {
    const targetSec = parseFloat(e.target.value);
    if (!isNaN(targetSec) && typeof sendControlFn === 'function') {
      sendControlFn({ action: 'seek_to', seconds: Math.max(0, targetSec) });
    }
    if (scrubResumeTimeout) clearTimeout(scrubResumeTimeout);
    scrubResumeTimeout = setTimeout(() => {
      isScrubbing = false;
    }, 600);
  };

  scrubber.addEventListener('mousedown', onScrubStart);
  scrubber.addEventListener('touchstart', onScrubStart, { passive: true });
  scrubber.addEventListener('input', onScrubInput);
  scrubber.addEventListener('change', onScrubCommit);
  scrubber.addEventListener('mouseup', onScrubCommit);
  scrubber.addEventListener('touchend', onScrubCommit);
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