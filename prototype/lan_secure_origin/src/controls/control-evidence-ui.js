// ==========================================
// Control Evidence UI Adapter
// ==========================================
// Manages compact badge and evidence status display on PC Controller

export function initControlEvidenceUI(evidenceClient) {
  const badge = document.getElementById('badgeEvidenceStatus');
  if (!badge) return;

  evidenceClient.addListener((evt) => {
    const record = evt.record;
    if (!record) return;

    if (evt.type === 'command_dispatched') {
      badge.className = 'badge badge-slate';
      badge.textContent = `⏳ ${record.action} (cmd)`;
      badge.title = `Dispatched: ${record.commandId}`;
    } else if (evt.type === 'server_accepted') {
      badge.className = 'badge badge-amber';
      badge.textContent = `🟡 Accepted (${record.action})`;
      badge.title = `Server Accepted: ${record.commandId}`;
    } else if (evt.type === 'state_advanced') {
      badge.className = 'badge badge-amber';
      badge.textContent = `🟡 ${record.verdict} (${record.action})`;
      badge.title = record.verdictReason;
    } else if (evt.type === 'verdict_recorded') {
      if (record.verdict === 'PASS') {
        badge.className = 'badge badge-green';
        badge.textContent = `🟢 PASS: ${record.action}`;
        badge.title = `Verified causal chain for ${record.commandId}: ${record.verdictReason}`;
      } else if (record.verdict === 'TIMEOUT') {
        badge.className = 'badge badge-red';
        badge.textContent = `🔴 TIMEOUT (${record.action})`;
        badge.title = record.verdictReason;
      } else if (record.verdict === 'REJECTED') {
        badge.className = 'badge badge-red';
        badge.textContent = `🔴 REJECTED (${record.action})`;
        badge.title = record.verdictReason;
      } else {
        badge.className = 'badge badge-slate';
        badge.textContent = `⚪ ${record.verdict}`;
        badge.title = record.verdictReason;
      }
    }
  });
}
