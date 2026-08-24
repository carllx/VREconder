// ==========================================
// Controller Input Probe & Telemetry Reporter (Issue #15)
// Detects and logs Gamepad, Keyboard, Pointer, and MediaSession inputs
// ==========================================
import { state, showFeedbackToast } from '../core/state.js';

let remoteLogFn = () => {};

export function setRemoteLogFunction(fn) {
  if (typeof fn === 'function') remoteLogFn = fn;
}

function logEvent(type, data) {
  remoteLogFn('INFO', `CONTROLLER_INPUT:${type}`, data);
}

export class ControllerInputProbe {
  constructor(commandModel = null) {
    this.commandModel = commandModel;
    this.gamepadConnected = false;
    this.lastGamepadId = '';
    this.lastButtonStates = {};
    this.lastAxesStates = {};
    this.lastEvent = null;
    this.recentEvents = [];
    this.activeInputs = {
      gamepads: [],
      lastKeyDown: null,
      lastPointer: null,
      lastMediaSessionAction: null
    };
    this.confirmTapTimer = null;

    this.initListeners();
    this.initMediaSession();
  }

  initListeners() {
    if (typeof window === 'undefined') return;

    // 1. Gamepad API Connection Events
    const onGpConnected = (e) => {
      const gp = e.gamepad;
      this.gamepadConnected = true;
      this.lastGamepadId = gp.id || 'Generic Gamepad';
      const info = {
        id: gp.id,
        index: gp.index,
        mapping: gp.mapping,
        buttonsCount: gp.buttons ? gp.buttons.length : 0,
        axesCount: gp.axes ? gp.axes.length : 0
      };
      logEvent('GAMEPAD_CONNECTED', info);
      showFeedbackToast(`🎮 Gamepad 连接: ${gp.id || 'SHINECON'}`);
    };

    window.addEventListener('gamepadconnected', onGpConnected);

    window.addEventListener('gamepaddisconnected', (e) => {
      this.gamepadConnected = false;
      logEvent('GAMEPAD_DISCONNECTED', {
        id: e.gamepad ? e.gamepad.id : '',
        index: e.gamepad ? e.gamepad.index : -1
      });
      showFeedbackToast('🎮 Gamepad 已断开');
    });

    // Focus Trap for iOS Safari Bluetooth Keyboard routing
    const trap = (typeof document !== 'undefined') ? document.getElementById('controllerFocusTrap') : null;
    const ensureFocus = () => {
      if (trap && document.activeElement !== trap) {
        try { trap.focus({ preventScroll: true }); } catch (e) {}
      }
    };
    if (trap) {
      trap.addEventListener('input', (e) => {
        const val = trap.value;
        const text = (e.data || val || '').toLowerCase();
        trap.value = '';
        this.recordEvent('INPUT_DATA', { data: e.data || val, inputType: e.inputType });

        if (text.includes('s')) {
          this.adjustDistance(-0.001);
        } else if (text.includes('w')) {
          this.adjustDistance(+0.001);
        }
      });
      trap.addEventListener('beforeinput', (e) => {
        this.recordEvent('BEFORE_INPUT', { data: e.data, inputType: e.inputType });
      });
      ensureFocus();
    }

    // 2. Keyboard Input Events (SHINECON / Mini VR remote keyboard mode)
    const onKey = (e, isDown) => {
      const info = {
        type: isDown ? 'keydown' : 'keyup',
        key: e.key,
        code: e.code,
        keyCode: e.keyCode,
        which: e.which,
        location: e.location,
        ctrlKey: e.ctrlKey,
        altKey: e.altKey,
        shiftKey: e.shiftKey,
        metaKey: e.metaKey,
        repeat: e.repeat,
        timestamp: Date.now()
      };

      if (isDown && !e.repeat) {
        this.activeInputs.lastKeyDown = info;
        this.recordEvent('KEYBOARD_DOWN', info);

        // Map Rocker HID keys if received via Focus Trap
        const code = e.code || '';
        const key = (e.key || '').toLowerCase();
        if (code === 'KeyS' || key === 's') {
          this.adjustDistance(-0.001);
        } else if (code === 'KeyW' || key === 'w') {
          this.adjustDistance(+0.001);
        }
      } else if (!isDown) {
        this.recordEvent('KEYBOARD_UP', info);
      }
    };

    window.addEventListener('keydown', (e) => onKey(e, true), { capture: true, passive: false });
    window.addEventListener('keyup', (e) => onKey(e, false), { capture: true, passive: false });
    if (typeof document !== 'undefined') {
      document.addEventListener('keydown', (e) => onKey(e, true), { capture: true, passive: false });
      document.addEventListener('keyup', (e) => onKey(e, false), { capture: true, passive: false });
    }

    // 3. Pointer / Mouse / Touch Events (SHINECON mouse/cursor mode)
    const onPointer = (e, action) => {
      ensureFocus();
      const info = {
        action,
        pointerType: e.pointerType || 'unknown',
        button: e.button,
        buttons: e.buttons,
        clientX: e.clientX,
        clientY: e.clientY,
        timestamp: Date.now()
      };
      this.activeInputs.lastPointer = info;
      this.recordEvent(`POINTER_${action.toUpperCase()}`, info);
      if (action === 'down') {
        showFeedbackToast(`🖱️ 指针/点击: btn=${e.button}`);
      }
    };

    window.addEventListener('pointerdown', (e) => onPointer(e, 'down'), { passive: true });
    window.addEventListener('pointerup', (e) => onPointer(e, 'up'), { passive: true });
    window.addEventListener('contextmenu', (e) => {
      this.recordEvent('CONTEXT_MENU', { clientX: e.clientX, clientY: e.clientY, timestamp: Date.now() });
    }, { passive: true });
  }

  adjustDistance(delta) {
    const now = Date.now();
    if (now - (this.lastDistanceAdjustTime || 0) < 100) return;
    this.lastDistanceAdjustTime = now;

    const baseD = 0.0433;
    state.temporaryScreenToLensOffset = Math.max(-0.005, Math.min(0.005, (state.temporaryScreenToLensOffset || 0) + delta));
    const effMm = (baseD + state.temporaryScreenToLensOffset) * 1000;
    const label = delta < 0 ? '↔ Farther' : '↔ Closer';
    showFeedbackToast(`${label} ${effMm.toFixed(1)} mm`);
  }

  initMediaSession() {
    if (typeof navigator === 'undefined' || !('mediaSession' in navigator)) return;

    const actions = [
      ['play', () => this.handleMediaAction('play')],
      ['pause', () => this.handleMediaAction('pause')],
      ['previoustrack', () => this.handleMediaAction('previoustrack')],
      ['nexttrack', () => this.handleMediaAction('nexttrack')],
      ['seekbackward', (details) => this.handleMediaAction('seekbackward', details)],
      ['seekforward', (details) => this.handleMediaAction('seekforward', details)],
      ['stop', () => this.handleMediaAction('stop')]
    ];

    for (const [actionName, handler] of actions) {
      try {
        navigator.mediaSession.setActionHandler(actionName, handler);
      } catch (e) {}
    }
  }

  handleMediaAction(action, details = null) {
    const info = { action, details, timestamp: Date.now() };
    this.activeInputs.lastMediaSessionAction = info;
    this.recordEvent('MEDIA_SESSION_ACTION', info);

    // Minimal SC-B03 MediaSession Adapter (Issue #15 Browser comment 5395427307)
    if (action === 'previoustrack') {
      this.adjustDistance(-0.001);
    } else if (action === 'nexttrack') {
      this.adjustDistance(+0.001);
    } else if (action === 'play' || action === 'pause') {
      // Confirm Tap: Single tap -> Open Menu, Double tap (350ms) -> Recenter
      if (this.confirmTapTimer) {
        clearTimeout(this.confirmTapTimer);
        this.confirmTapTimer = null;
        showFeedbackToast('🎯 Recenter');
        if (this.commandModel) this.commandModel.recenter();
      } else {
        this.confirmTapTimer = setTimeout(() => {
          this.confirmTapTimer = null;
          showFeedbackToast('⚡ 打开菜单');
          if (this.commandModel) this.commandModel.openControls();
        }, 350);
      }
    }
  }

  recordEvent(type, data) {
    this.lastEvent = { type, data, time: new Date().toISOString() };
    this.recentEvents.unshift(this.lastEvent);
    if (this.recentEvents.length > 20) this.recentEvents.pop();
    logEvent(type, data);
  }

  // Polling loop for Gamepad states (called in renderLoop / 60Hz)
  pollGamepads() {
    if (typeof navigator === 'undefined' || typeof navigator.getGamepads !== 'function') return;

    const gamepads = navigator.getGamepads();
    if (!gamepads) return;

    const activeList = [];
    for (let i = 0; i < gamepads.length; i++) {
      const gp = gamepads[i];
      if (!gp) continue;

      activeList.push({
        id: gp.id,
        index: gp.index,
        mapping: gp.mapping,
        connected: gp.connected,
        buttons: (gp.buttons || []).map((b, bIdx) => ({
          index: bIdx,
          pressed: b.pressed,
          value: b.value
        })),
        axes: (gp.axes || []).map((a, aIdx) => ({
          index: aIdx,
          value: Math.round(a * 1000) / 1000
        }))
      });

      // Detect button edge transitions
      if (gp.buttons) {
        for (let b = 0; b < gp.buttons.length; b++) {
          const btn = gp.buttons[b];
          const key = `${gp.index}_b_${b}`;
          const wasPressed = !!this.lastButtonStates[key];
          if (btn.pressed && !wasPressed) {
            this.lastButtonStates[key] = true;
            this.recordEvent('GAMEPAD_BUTTON_DOWN', { gamepadIndex: gp.index, buttonIndex: b, value: btn.value });
          } else if (!btn.pressed && wasPressed) {
            this.lastButtonStates[key] = false;
            this.recordEvent('GAMEPAD_BUTTON_UP', { gamepadIndex: gp.index, buttonIndex: b, value: btn.value });
          }
        }
      }

      // Detect axis deflection transitions (deadzone 0.25)
      if (gp.axes) {
        for (let a = 0; a < gp.axes.length; a++) {
          const val = gp.axes[a];
          const key = `${gp.index}_a_${a}`;
          const prevVal = this.lastAxesStates[key] || 0;
          if (Math.abs(val - prevVal) > 0.35) {
            this.lastAxesStates[key] = val;
            this.recordEvent('GAMEPAD_AXIS_MOVE', { gamepadIndex: gp.index, axisIndex: a, value: Math.round(val * 100) / 100 });
          }
        }
      }
    }

    this.activeInputs.gamepads = activeList;
  }

  getTelemetryData() {
    return {
      gamepadConnected: this.gamepadConnected || this.activeInputs.gamepads.length > 0,
      activeGamepads: this.activeInputs.gamepads,
      lastEvent: this.lastEvent,
      recentEvents: this.recentEvents.slice(0, 8),
      lastKeyDown: this.activeInputs.lastKeyDown,
      lastPointer: this.activeInputs.lastPointer,
      lastMediaSessionAction: this.activeInputs.lastMediaSessionAction
    };
  }
}
