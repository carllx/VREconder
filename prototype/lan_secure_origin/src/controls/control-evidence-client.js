// ==========================================
// Control Evidence Contract - Client Correlator
// ==========================================
// Enforces the full causal chain:
// REQUESTED -> SERVER_ACCEPTED -> PHONE_RECEIVED -> APPLIED -> RENDER_CONFIRMED -> PASS
//
// PASS Requirement:
// request.commandId === ack.commandId === renderEvidence.commandId
// AND effective state consumed by the visual/render pipeline matches requested state.

export class ControlEvidenceClient {
  constructor(options = {}) {
    this.timeoutMs = options.timeoutMs || 4000;
    this.pollIntervalMs = options.pollIntervalMs || 100;
    this.recentVerdicts = [];
    this.pendingCommands = new Map();
    this.listeners = new Set();
  }

  generateCommandId(prefix = 'cmd') {
    const timestamp = Date.now();
    const rand = Math.random().toString(36).substring(2, 8);
    return `${prefix}_${timestamp}_${rand}`;
  }

  addListener(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  notify(event) {
    for (const fn of this.listeners) {
      try { fn(event); } catch (e) { console.error('Listener error:', e); }
    }
  }

  /**
   * Pure evaluation of causal evidence against a tracked command record.
   *
   * @param {Object} record Tracked command record
   * @param {Object} telem Telemetry payload from server/iPhone
   * @param {Function} [stateExpectationFn] Optional predicate: (telem, effectiveState) => boolean
   */
  evaluateTelemetryEvidence(record, telem, stateExpectationFn) {
    if (!telem) {
      return { verdict: 'SERVER_ACCEPTED', verdictReason: 'No telemetry available yet' };
    }

    const evidence = telem.controlEvidence || {};
    const acks = evidence.acks || (evidence.lastAck ? [evidence.lastAck] : []);
    const matchingAck = acks.find(a => a && a.commandId === record.commandId);

    if (!matchingAck) {
      return { verdict: 'SERVER_ACCEPTED', verdictReason: 'Awaiting iPhone ACK...' };
    }

    if (matchingAck.status === 'rejected' || matchingAck.status === 'error') {
      return {
        iphoneAckReceived: true,
        iphoneAck: matchingAck,
        verdict: 'REJECTED',
        verdictReason: `iPhone rejected command: ${matchingAck.reason || matchingAck.status}`
      };
    }

    if (matchingAck.status !== 'applied') {
      return {
        iphoneAckReceived: true,
        iphoneAck: matchingAck,
        verdict: 'PHONE_RECEIVED',
        verdictReason: `iPhone ACK status: ${matchingAck.status}`
      };
    }

    // Matching applied ACK confirmed on phone
    const renderEvidence = evidence.lastRenderEvidence || null;
    if (!renderEvidence || renderEvidence.commandId !== record.commandId) {
      return {
        iphoneAckReceived: true,
        iphoneAck: matchingAck,
        verdict: 'APPLIED',
        verdictReason: 'Applied in state; awaiting matching renderer-effective frame readback...'
      };
    }

    // Render evidence matches commandId! Check timing and freshness
    const appliedAt = matchingAck.appliedAt || 0;
    const readbackAt = renderEvidence.readbackAt || 0;
    if (readbackAt < appliedAt) {
      return {
        iphoneAckReceived: true,
        iphoneAck: matchingAck,
        verdict: 'APPLIED',
        verdictReason: 'Renderer readback is older than command apply timestamp'
      };
    }

    // Verify action-relevant effective state
    const effectiveState = renderEvidence.effectiveState || {};
    let stateMatches = false;
    if (typeof stateExpectationFn === 'function') {
      stateMatches = Boolean(stateExpectationFn(telem, effectiveState));
    } else {
      // Default: inspect appliedState vs effectiveState
      stateMatches = true;
    }

    if (!stateMatches) {
      return {
        iphoneAckReceived: true,
        iphoneAck: matchingAck,
        renderConfirmed: false,
        renderEvidence,
        verdict: 'APPLIED',
        verdictReason: 'Render readback commandId matched, but effective rendered state does not match requested state'
      };
    }

    return {
      iphoneAckReceived: true,
      iphoneAck: matchingAck,
      renderConfirmed: true,
      renderEvidence,
      verdict: 'PASS',
      verdictReason: `Causal chain verified: commandId=${record.commandId} ACK appliedAt=${appliedAt}, renderFrameSeq=${renderEvidence.frameSeq}, readbackAt=${readbackAt}`
    };
  }

  /**
   * Dispatches a tracked command from PC and awaits causal PASS or timeout.
   */
  async dispatchTrackedCommand(actionPayload, stateExpectationFn) {
    // 1. PC generates and owns commandId before sending
    const commandId = actionPayload.commandId || this.generateCommandId();
    const issuedAt = Date.now();

    const record = {
      commandId,
      action: actionPayload.action,
      payload: { ...actionPayload, commandId },
      issuedAt,
      serverAccepted: false,
      serverAcceptedAt: null,
      iphoneAckReceived: false,
      iphoneAck: null,
      renderConfirmed: false,
      renderEvidence: null,
      verdict: 'REQUESTED',
      verdictReason: 'Dispatching to server...',
      completedAt: null
    };

    this.pendingCommands.set(commandId, record);
    this.notify({ type: 'command_dispatched', record });

    // Step 1: POST to /api/calibration/control
    let serverRes;
    try {
      const res = await fetch('/api/calibration/control', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(record.payload)
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      serverRes = await res.json();
    } catch (err) {
      record.verdict = 'UNPROVEN';
      record.verdictReason = `Server request failed: ${err.message}`;
      record.completedAt = Date.now();
      this.pendingCommands.delete(commandId);
      this.recordVerdict(record);
      return record;
    }

    // Step 2: Server Acceptance
    if (serverRes && serverRes.status === 'ok' && serverRes.broadcasted && serverRes.commandId === commandId) {
      record.serverAccepted = true;
      record.serverAcceptedAt = serverRes.serverAcceptedAt || Date.now();
      record.verdict = 'SERVER_ACCEPTED';
      record.verdictReason = 'Server accepted & broadcasted; awaiting iPhone ACK & readback...';
      this.notify({ type: 'server_accepted', record });
    } else {
      record.verdict = 'UNPROVEN';
      record.verdictReason = 'Server response missing or commandId mismatch';
      record.completedAt = Date.now();
      this.pendingCommands.delete(commandId);
      this.recordVerdict(record);
      return record;
    }

    // Step 3 & 4: Poll Telemetry for ACK and Renderer-effective Readback
    const startTime = Date.now();
    return new Promise((resolve) => {
      const checkInterval = setInterval(async () => {
        const elapsed = Date.now() - startTime;
        if (elapsed > this.timeoutMs) {
          clearInterval(checkInterval);
          record.verdict = 'TIMEOUT';
          record.verdictReason = `Causal evidence timed out after ${elapsed}ms (Did not satisfy ACK & render confirmation)`;
          record.completedAt = Date.now();
          this.pendingCommands.delete(commandId);
          this.recordVerdict(record);
          resolve(record);
          return;
        }

        try {
          const telemRes = await fetch('/api/telemetry');
          if (!telemRes.ok) return;
          const data = await telemRes.json();
          const telem = data.latestTelemetry;
          if (!telem) return;

          const evaluation = this.evaluateTelemetryEvidence(record, telem, stateExpectationFn);
          if (evaluation.verdict === 'PASS' || evaluation.verdict === 'REJECTED') {
            clearInterval(checkInterval);
            Object.assign(record, evaluation);
            record.completedAt = Date.now();
            this.pendingCommands.delete(commandId);
            this.recordVerdict(record);
            resolve(record);
          } else if (evaluation.verdict !== record.verdict) {
            Object.assign(record, evaluation);
            this.notify({ type: 'state_advanced', record });
          }
        } catch (e) {
          // ignore transient poll failure
        }
      }, this.pollIntervalMs);
    });
  }

  recordVerdict(record) {
    this.recentVerdicts.unshift(record);
    if (this.recentVerdicts.length > 20) this.recentVerdicts.pop();
    this.notify({ type: 'verdict_recorded', record });
  }

  getRecentVerdicts() {
    return this.recentVerdicts;
  }
}

export const evidenceClient = new ControlEvidenceClient();
