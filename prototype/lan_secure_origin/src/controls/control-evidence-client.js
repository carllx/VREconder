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
   * Derives an action-specific expectation predicate for allowlisted commands.
   * Returns null for non-allowlisted / unsupported actions (which must fail closed).
   */
  deriveActionExpectation(payload) {
    if (!payload || !payload.action) return null;
    const act = payload.action;

    if (act === 'set_diagnostic_overlay') {
      const key = payload.key;
      const val = payload.value;
      if (['showGrid', 'showPlumbLines', 'showHorizon'].includes(key) && typeof val === 'boolean') {
        return (telem, effectiveState) => {
          return Boolean(
            effectiveState &&
            effectiveState.diagOverlay &&
            effectiveState.diagOverlay[key] === val
          );
        };
      }
      return null;
    }

    if (act === 'set_reference_grid') {
      const enabled = payload.enabled;
      if (typeof enabled === 'boolean') {
        return (telem, effectiveState) => {
          return Boolean(
            effectiveState &&
            effectiveState.showReferenceGrid === enabled
          );
        };
      }
      return null;
    }

    if (act === 'set_diagnostic_eye') {
      const eye = payload.eye;
      if (typeof eye === 'number' && (eye === 0 || eye === 1)) {
        return (telem, effectiveState) => {
          return Boolean(
            effectiveState &&
            effectiveState.selectedEye === eye
          );
        };
      }
      return null;
    }

    return null;
  }

  isTrackedAction(action) {
    return (
      action === 'set_diagnostic_overlay' ||
      action === 'set_reference_grid' ||
      action === 'set_diagnostic_eye'
    );
  }

  /**
   * Pure evaluation of causal evidence against a tracked command record.
   * Enforces:
   * 1. request.commandId === ack.commandId === renderEvidence.commandId
   * 2. request.action === ack.action === renderEvidence.action
   * 3. Monotonic causal timing: issuedAt <= serverAcceptedAt <= phoneReceivedAt <= appliedAt <= readbackAt
   * 4. Strict action-specific effective state match (fails closed if expectation is absent or unmet).
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

    // Verify action match on ACK
    if (matchingAck.action !== record.action) {
      return {
        iphoneAckReceived: true,
        iphoneAck: matchingAck,
        verdict: 'REJECTED',
        verdictReason: `ACK action mismatch: expected ${record.action}, got ${matchingAck.action}`
      };
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

    // Matching applied ACK confirmed on phone. Search recent render evidence collection
    const renderEntries = evidence.renderEvidence || (evidence.lastRenderEvidence ? [evidence.lastRenderEvidence] : []);
    const matchingRender = renderEntries.find(r => r && r.commandId === record.commandId);

    if (!matchingRender) {
      return {
        iphoneAckReceived: true,
        iphoneAck: matchingAck,
        verdict: 'APPLIED',
        verdictReason: 'Applied in state; awaiting matching renderer-effective frame readback...'
      };
    }

    // Verify action match on render evidence
    if (matchingRender.action !== record.action) {
      return {
        iphoneAckReceived: true,
        iphoneAck: matchingAck,
        renderEvidence: matchingRender,
        verdict: 'APPLIED',
        verdictReason: `Render evidence action mismatch: expected ${record.action}, got ${matchingRender.action}`
      };
    }

    // Verify monotonic causal timing:
    // issuedAt <= serverAcceptedAt <= phoneReceivedAt <= appliedAt <= readbackAt
    const issuedAt = record.issuedAt || 0;
    const serverAcceptedAt = record.serverAcceptedAt || issuedAt;
    const phoneReceivedAt = matchingAck.phoneReceivedAt || serverAcceptedAt;
    const appliedAt = matchingAck.appliedAt || phoneReceivedAt;
    const readbackAt = matchingRender.readbackAt || 0;

    const isMonotonic = (
      issuedAt <= serverAcceptedAt &&
      serverAcceptedAt <= (phoneReceivedAt + 50) && // allow 50ms clock skew tolerance across local network
      phoneReceivedAt <= appliedAt &&
      appliedAt <= readbackAt
    );

    if (!isMonotonic) {
      return {
        iphoneAckReceived: true,
        iphoneAck: matchingAck,
        renderEvidence: matchingRender,
        verdict: 'APPLIED',
        verdictReason: `Non-monotonic causal timing (issued:${issuedAt} server:${serverAcceptedAt} phone:${phoneReceivedAt} applied:${appliedAt} readback:${readbackAt})`
      };
    }

    // Strict action-specific effective state verification (FAIL CLOSED)
    const expectation = stateExpectationFn || this.deriveActionExpectation(record.payload);
    if (typeof expectation !== 'function') {
      return {
        iphoneAckReceived: true,
        iphoneAck: matchingAck,
        renderEvidence: matchingRender,
        verdict: 'UNPROVEN',
        verdictReason: 'No supported state expectation defined for action; scientific PASS forbidden'
      };
    }

    const effectiveState = matchingRender.effectiveState || {};
    const stateMatches = Boolean(expectation(telem, effectiveState));

    if (!stateMatches) {
      return {
        iphoneAckReceived: true,
        iphoneAck: matchingAck,
        renderConfirmed: false,
        renderEvidence: matchingRender,
        verdict: 'APPLIED',
        verdictReason: 'Render readback commandId matched, but effective rendered state does not match requested state'
      };
    }

    return {
      iphoneAckReceived: true,
      iphoneAck: matchingAck,
      renderConfirmed: true,
      renderEvidence: matchingRender,
      verdict: 'PASS',
      verdictReason: `Causal chain verified: commandId=${record.commandId} ACK appliedAt=${appliedAt}, renderFrameSeq=${matchingRender.frameSeq}, readbackAt=${readbackAt}`
    };
  }

  /**
   * Dispatches a command.
   * If action is in the allowlist, dispatches as a tracked experimental command with a fresh commandId.
   * If action is NOT in the allowlist, dispatches as untracked (no polling loop, returns immediately).
   */
  async dispatchTrackedCommand(actionPayload, explicitExpectationFn) {
    if (!actionPayload || !actionPayload.action) {
      return { verdict: 'UNPROVEN', verdictReason: 'Missing action in payload' };
    }

    const act = actionPayload.action;
    const isTracked = this.isTrackedAction(act);

    // If unsupported / not allowlisted, send untracked without polling
    if (!isTracked) {
      try {
        const res = await fetch('/api/calibration/control', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ...actionPayload, untracked: true })
        });
        const json = await res.json().catch(() => ({}));
        return {
          action: act,
          untracked: true,
          serverAccepted: Boolean(res.ok && json.broadcasted),
          verdict: 'UNPROVEN',
          verdictReason: 'Action is not an allowlisted scientific control'
        };
      } catch (err) {
        return {
          action: act,
          untracked: true,
          serverAccepted: false,
          verdict: 'UNPROVEN',
          verdictReason: `Server request failed: ${err.message}`
        };
      }
    }

    // Fresh commandId strictly generated on PC for every tracked experimental dispatch
    const commandId = this.generateCommandId();
    const issuedAt = Date.now();

    const record = {
      commandId,
      action: act,
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

    const expectationFn = explicitExpectationFn || this.deriveActionExpectation(record.payload);

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

          const evaluation = this.evaluateTelemetryEvidence(record, telem, expectationFn);
          if (evaluation.verdict === 'PASS' || evaluation.verdict === 'REJECTED' || evaluation.verdict === 'UNPROVEN') {
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
