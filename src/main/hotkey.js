/**
 * Global push-to-talk hotkey listener using uiohook-napi.
 *
 * Tracks key state globally and fires onStart/onStop when the
 * configured combo is held/released — needed for push-to-talk
 * because Electron's globalShortcut has no key-up event.
 */

import { uIOhook, UiohookKey } from 'uiohook-napi';

// -----------------------------------------------------------------------
// Key mapping — maps human-readable tokens to uiohook keycodes
// -----------------------------------------------------------------------

const KEY_MAP = {
  ctrl:       UiohookKey.Ctrl,
  ctrl_l:     UiohookKey.Ctrl,
  ctrl_r:     UiohookKey.CtrlRight,
  shift:      UiohookKey.Shift,
  shift_l:    UiohookKey.Shift,
  shift_r:    UiohookKey.ShiftRight,
  alt:        UiohookKey.Alt,
  alt_l:      UiohookKey.Alt,
  alt_r:      UiohookKey.AltRight,
  meta:       UiohookKey.Meta,
  cmd:        UiohookKey.Meta,
  space:      UiohookKey.Space,
  tab:        UiohookKey.Tab,
  enter:      UiohookKey.Enter,
  esc:        UiohookKey.Escape,
  escape:     UiohookKey.Escape,
  backspace:  UiohookKey.Backspace,
  delete:     UiohookKey.Delete,
  insert:     UiohookKey.Insert,
  home:       UiohookKey.Home,
  end:        UiohookKey.End,
  pageup:     UiohookKey.PageUp,
  page_up:    UiohookKey.PageUp,
  pagedown:   UiohookKey.PageDown,
  page_down:  UiohookKey.PageDown,
  up:         UiohookKey.ArrowUp,
  down:       UiohookKey.ArrowDown,
  left:       UiohookKey.ArrowLeft,
  right:      UiohookKey.ArrowRight,
  f1:  UiohookKey.F1,  f2:  UiohookKey.F2,  f3:  UiohookKey.F3,
  f4:  UiohookKey.F4,  f5:  UiohookKey.F5,  f6:  UiohookKey.F6,
  f7:  UiohookKey.F7,  f8:  UiohookKey.F8,  f9:  UiohookKey.F9,
  f10: UiohookKey.F10, f11: UiohookKey.F11, f12: UiohookKey.F12,
  // Letters
  a: UiohookKey.A, b: UiohookKey.B, c: UiohookKey.C, d: UiohookKey.D,
  e: UiohookKey.E, f: UiohookKey.F, g: UiohookKey.G, h: UiohookKey.H,
  i: UiohookKey.I, j: UiohookKey.J, k: UiohookKey.K, l: UiohookKey.L,
  m: UiohookKey.M, n: UiohookKey.N, o: UiohookKey.O, p: UiohookKey.P,
  q: UiohookKey.Q, r: UiohookKey.R, s: UiohookKey.S, t: UiohookKey.T,
  u: UiohookKey.U, v: UiohookKey.V, w: UiohookKey.W, x: UiohookKey.X,
  y: UiohookKey.Y, z: UiohookKey.Z,
  // Digits
  '0': UiohookKey['0'], '1': UiohookKey['1'], '2': UiohookKey['2'],
  '3': UiohookKey['3'], '4': UiohookKey['4'], '5': UiohookKey['5'],
  '6': UiohookKey['6'], '7': UiohookKey['7'], '8': UiohookKey['8'],
  '9': UiohookKey['9'],
  // Punctuation (names follow DOM KeyboardEvent.code)
  backquote:    UiohookKey.Backquote,
  minus:        UiohookKey.Minus,
  equal:        UiohookKey.Equal,
  bracketleft:  UiohookKey.BracketLeft,
  bracketright: UiohookKey.BracketRight,
  backslash:    UiohookKey.Backslash,
  semicolon:    UiohookKey.Semicolon,
  quote:        UiohookKey.Quote,
  comma:        UiohookKey.Comma,
  period:       UiohookKey.Period,
  slash:        UiohookKey.Slash,
  // Friendly aliases for common characters
  '`': UiohookKey.Backquote,
  '~': UiohookKey.Backquote,
  '-': UiohookKey.Minus,
  '=': UiohookKey.Equal,
  '[': UiohookKey.BracketLeft,
  ']': UiohookKey.BracketRight,
  '\\': UiohookKey.Backslash,
  ';': UiohookKey.Semicolon,
  "'": UiohookKey.Quote,
  ',': UiohookKey.Comma,
  '.': UiohookKey.Period,
  '/': UiohookKey.Slash,
};

/**
 * Collapse left/right modifier variants to canonical form.
 */
const CANONICAL = {
  [UiohookKey.CtrlRight]:  UiohookKey.Ctrl,
  [UiohookKey.ShiftRight]: UiohookKey.Shift,
  [UiohookKey.AltRight]:   UiohookKey.Alt,
  [UiohookKey.MetaRight]:  UiohookKey.Meta,
};

function normalise(keycode) {
  return CANONICAL[keycode] ?? keycode;
}

function parseKey(token) {
  const t = token.trim().toLowerCase();
  if (t in KEY_MAP) return KEY_MAP[t];
  throw new Error(`Unknown key: "${token}"`);
}

// -----------------------------------------------------------------------
// HotkeyActivation class
// -----------------------------------------------------------------------

export class HotkeyActivation {
  /**
   * @param {object} opts
   * @param {string}          opts.hotkey   e.g. "ctrl+shift+space"
   * @param {() => void}      opts.onStart  Called when combo is held
   * @param {() => void}      opts.onStop   Called when combo is released
   */
  constructor({ hotkey = 'ctrl+shift+space', onStart, onStop }) {
    this._combo = new Set(hotkey.split('+').map((t) => normalise(parseKey(t))));
    this._onStart = onStart;
    this._onStop = onStop;
    this._pressed = new Set();
    this._active = false;
    this._started = false;
  }

  start() {
    if (this._started) return;
    this._started = true;

    uIOhook.on('keydown', (e) => this._onKeyDown(e));
    uIOhook.on('keyup', (e) => this._onKeyUp(e));
    uIOhook.start();
  }

  stop() {
    if (!this._started) return;
    this._started = false;
    uIOhook.stop();
    this._pressed.clear();
    this._active = false;
  }

  isActive() {
    return this._active;
  }

  // -- internal -----------------------------------------------------------

  _onKeyDown(e) {
    const norm = normalise(e.keycode);
    this._pressed.add(norm);

    if (!this._active && this._comboHeld()) {
      this._active = true;
      if (this._onStart) this._onStart();
    }
  }

  _onKeyUp(e) {
    const norm = normalise(e.keycode);
    this._pressed.delete(norm);

    if (this._active && !this._comboHeld()) {
      this._active = false;
      if (this._onStop) this._onStop();
    }
  }

  /** Return true when every key in the combo is currently pressed. */
  _comboHeld() {
    for (const k of this._combo) {
      if (!this._pressed.has(k)) return false;
    }
    return true;
  }
}
