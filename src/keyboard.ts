// Keyboard navigation mode.
//
// An activation chord (e.g. Alt+Q) enters navigation mode for as long as the modifier is
// held. Pressing the activation key again while still holding the modifier (Alt+Q, Q) makes
// the mode sticky: it then lasts until the activation key (or Escape) is pressed again.
// While in navigation mode, plain keys (with the activation modifier held or not) run
// actions. Nothing is hard-coded: the activation chord and all bindings come from the config.

import { PaneNode, Side } from "./model";
import { View } from "./view";
import { Command, Direction, Workspace } from "./workspace";

type Dir = "Left" | "Right" | "Up" | "Down";
export type NavAction =
  | Command
  | "toggleMaximize"
  | "float"
  | "closeTab"
  | "closePane"
  | "group"
  | "collapse"
  | "renameTab"
  /** name the focused pane (or rename it), in place */
  | "namePane"
  /** toggle the focus in the marks ("stored selections": `Workspace.toggleMark`) */
  | "mark"
  /** move what's marked to the focus (`Workspace.moveMarked`) */
  | "moveMarked"
  /** remove the finished cells (done, standby, error) in the selection (`Workspace.clear`) */
  | "clear"
  /** the focus, wider or narrower (its share of a row; see `Workspace.resizeFocus`) */
  | "growWidth"
  | "shrinkWidth"
  /** the focus, taller or shorter (its share of a column, or a scroll-column cell's height) */
  | "growHeight"
  | "shrinkHeight"
  /** a new cell (created by the focused one) into the focused cell's own tabs */
  | "insertInto"
  /** a new cell (created by the focused one) beside the focused cell, on that side */
  | `insert${Dir}`
  /** a new cell into the tabs of the cell on that side (or where it would be) */
  | `insertInto${Dir}`
  /** the focused tab, moved beside the focused cell, on that side */
  | `move${Dir}`
  /** the focused tab, moved into the tabs of the cell on that side (or where it would be) */
  | `moveInto${Dir}`;

/**
 * What a key does in navigation mode: a built-in action (by name), or the host's own command, a
 * function given the workspace, the view and the controller. (Its `name` labels it, e.g. in
 * a legend.)
 */
export type NavBinding = NavAction | ((ctx: NavContext) => void);

/** A shortcut: what it does, and whether it also works while typing in a text field. */
export type Shortcut = NavBinding | { run: NavBinding; inFields?: boolean };

export interface NavContext {
  ws: Workspace;
  view: View;
  nav: KeyboardNav;
}

const DIRS: Record<Dir, { side: Side; dir: Direction }> = {
  Left: { side: "left", dir: "left" },
  Right: { side: "right", dir: "right" },
  Up: { side: "top", dir: "up" },
  Down: { side: "bottom", dir: "down" },
};

export type Modifier = "Control" | "Alt" | "Meta" | "Shift";

export interface NavConfig {
  /**
   * The activation chord: a modifier plus a key (`KeyboardEvent.code`), e.g. Alt + KeyQ.
   * `side` restricts which physical modifier key counts: "left", "right", or "either"
   * (default). E.g. "left" leaves the right Option key free for typing special characters.
   */
  activation: { modifier: Modifier; code: string; side?: "left" | "right" | "either" };
  /**
   * Bindings while in navigation mode. Keys are chords of `KeyboardEvent.code` with optional
   * `Shift+`, `Alt+`, `Ctrl+`, `Meta+` prefixes (in that order), *not* counting the activation
   * modifier, which may or may not be held. E.g. "ArrowLeft", "Shift+ArrowLeft", "KeyM".
   */
  bindings: Record<string, NavBinding>;
  /**
   * Prefix keys: after a prefix key (same chord syntax), the next key is looked up in its own
   * table. Holding the prefix key down keeps it active for every key pressed meanwhile.
   * E.g. `{ KeyS: { ArrowLeft: "swapLeft", … } }` makes S then ← swap left. Modifiers that
   * are part of the prefix's chord are ignored on the next key (e.g. Shift+X, then Shift+← = ←).
   */
  prefixes?: Record<string, Record<string, NavBinding>>;
  /**
   * Shortcuts: keys that work without entering navigation mode (and in it, for keys it doesn't
   * bind), e.g. `{ "Ctrl+Tab": "nextTab", "Meta+ArrowLeft": "prevTab" }`. Keys are full chords:
   * every modifier counts, the activation one included (in any order; "Control", "Cmd",
   * "Option" are understood too). Not while typing in a text field (Cmd+← moves the caret
   * there), unless the shortcut says so: `{ run, inFields: true }`.
   */
  shortcuts?: Record<string, Shortcut>;
}

export type NavMode = "off" | "held" | "sticky";

/**
 * Forward a same-origin iframe's key events to the host window, so that the navigation keys
 * work while the focus is inside it (e.g. Alt+Q to get out). A forwarded key the host handles
 * (cancels) is cancelled in the iframe too. Re-installed whenever the iframe loads a new
 * document. Cross-origin iframes can't be bridged (their keys never reach the host).
 */
export function bridgeFrameKeys(frame: HTMLIFrameElement): void {
  const host = frame.ownerDocument.defaultView!;
  const install = () => {
    let doc: Document | null | undefined;
    try {
      doc = frame.contentDocument; // null, or throws, when cross-origin
    } catch {
      return;
    }
    const d = doc as (Document & { carreauBridged?: boolean }) | null | undefined;
    if (!d || d.carreauBridged) return;
    d.carreauBridged = true;
    for (const type of ["keydown", "keyup"] as const)
      d.addEventListener(
        type,
        (e) => {
          const { key, code, altKey, ctrlKey, metaKey, shiftKey, repeat, location } = e;
          const copy = new KeyboardEvent(type, { key, code, altKey, ctrlKey, metaKey, shiftKey, repeat, location, bubbles: true, cancelable: true });
          // (Its target is the window: say whether it was typed in a text field, for shortcuts.)
          (copy as KeyboardEvent & { carreauInField?: boolean }).carreauInField = isTextField(e.target);
          host.dispatchEvent(copy);
          if (copy.defaultPrevented) {
            e.preventDefault();
            e.stopPropagation();
          }
        },
        { capture: true },
      );
  };
  frame.addEventListener("load", install);
  install();
}

/** Whether keys typed in this element are text (a field, or an editable element). */
function isTextField(t: EventTarget | null): boolean {
  return t instanceof HTMLElement && (t.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(t.tagName));
}

/** A key event's chord, every modifier included (Shift, Alt, Ctrl, Meta, in that order). */
function fullChord(e: KeyboardEvent): string {
  return [e.shiftKey && "Shift", e.altKey && "Alt", e.ctrlKey && "Ctrl", e.metaKey && "Meta", e.code].filter(Boolean).join("+");
}

const MOD_ORDER = ["Shift", "Alt", "Ctrl", "Meta"];
const MOD_ALIASES: Record<string, string> = { Control: "Ctrl", Cmd: "Meta", Command: "Meta", Option: "Alt" };

/** A chord as written in a config, in the canonical form (modifiers in order, aliases resolved). */
function canonical(chord: string): string {
  const parts = chord.split("+");
  const code = parts.pop()!;
  const mods = parts.map((m) => MOD_ALIASES[m] ?? m).sort((a, b) => MOD_ORDER.indexOf(a) - MOD_ORDER.indexOf(b));
  return [...mods, code].join("+");
}

/** Look a chord up in a config table, whichever way its keys are written. */
function lookup<T>(table: Record<string, T> | undefined, chord: string): T | undefined {
  if (!table) return undefined;
  if (chord in table) return table[chord];
  for (const [k, v] of Object.entries(table)) if (canonical(k) === chord) return v;
  return undefined;
}

const MOD_FLAG: Record<Modifier, "ctrlKey" | "altKey" | "metaKey" | "shiftKey"> = {
  Control: "ctrlKey",
  Alt: "altKey",
  Meta: "metaKey",
  Shift: "shiftKey",
};

export class KeyboardNav {
  mode: NavMode = "off";
  /** Physical modifier keys currently held (`KeyboardEvent.code`, e.g. "AltLeft"). */
  private heldMods = new Set<string>();
  /** The pending prefix (its chord), if any. */
  prefix: string | null = null;
  /** Whether the prefix key is still held, and whether it has been used while held. */
  private prefixHeld = false;
  private prefixUsed = false;
  private listeners: ((mode: NavMode) => void)[] = [];

  constructor(
    readonly ws: Workspace,
    readonly view: View,
    readonly config: NavConfig,
    target: Window = window,
  ) {
    target.addEventListener("keydown", (e) => this.keydown(e), { capture: true });
    target.addEventListener("keyup", (e) => this.keyup(e), { capture: true });
    // A modifier released while the window had no focus never sends keyup.
    target.addEventListener("blur", () => {
      this.heldMods.clear();
      // (The focus went elsewhere: don't let the cell take it back.)
      if (this.mode === "held") this.setMode("off", false);
    });
  }

  onChange(fn: (mode: NavMode) => void): void {
    this.listeners.push(fn);
  }

  /**
   * Change mode. Leaving navigation mode commits the focus to the focused cell (see
   * `Lifecycle.commitFocus`), unless `commit` is false. Entering it takes the keyboard focus
   * back from an iframe (the keys were forwarded from it: see `bridgeFrameKeys`).
   */
  private setMode(mode: NavMode, commit = true): void {
    if (mode === "off") this.clearPrefix();
    if (mode === this.mode) return;
    const was = this.mode;
    // Multi-selections, and marks, only live within navigation mode.
    if (mode === "off") {
      this.ws.clearMultiSelection();
      this.ws.clearMarks();
    }
    this.mode = mode;
    this.view.setNavMode(mode);
    if (was === "off") {
      // Take the keyboard focus back from inside the workspace (an iframe, a text field of
      // its own): the following keys are navigation.
      const a = document.activeElement;
      if (a instanceof HTMLElement && this.view.el.contains(a)) {
        a.blur();
        if (a instanceof HTMLIFrameElement) window.focus();
      }
    }
    for (const fn of this.listeners) fn(mode);
    if (mode === "off" && commit) this.view.commitFocus();
  }

  /** Whether the activation modifier is held, on the configured side. */
  private modifierHeld(e: KeyboardEvent): boolean {
    const { modifier, side = "either" } = this.config.activation;
    if (!e[MOD_FLAG[modifier]]) return false;
    if (side === "either") return true;
    // The event for the other key doesn't tell which modifier key is down: use the
    // modifier key events we have seen.
    return this.heldMods.has(modifier + (side === "left" ? "Left" : "Right"));
  }

  /** Whether a key event is for the activation modifier key on the configured side. */
  private isActivationModifierKey(e: KeyboardEvent): boolean {
    const { modifier, side = "either" } = this.config.activation;
    if (e.key !== modifier) return false;
    return side === "either" || e.code === modifier + (side === "left" ? "Left" : "Right");
  }

  /** The chord of a key event, leaving out the activation modifier. */
  chord(e: KeyboardEvent): string {
    const mod = this.config.activation.modifier;
    return [
      e.shiftKey && mod !== "Shift" && "Shift",
      e.altKey && mod !== "Alt" && "Alt",
      e.ctrlKey && mod !== "Control" && "Ctrl",
      e.metaKey && mod !== "Meta" && "Meta",
      e.code,
    ]
      .filter(Boolean)
      .join("+");
  }

  private keydown(e: KeyboardEvent): void {
    const { activation } = this.config;
    if (/^(Alt|Control|Meta|Shift)(Left|Right)$/.test(e.code)) this.heldMods.add(e.code);
    // Typing in a text field is not navigation. But in the workspace's own fields (e.g. a
    // title being edited), the activation chord still works: that's the way out of them.
    // (Shortcuts that say so work there too.)
    const t = e.target as HTMLElement | null;
    const inField = isTextField(t) || !!(e as KeyboardEvent & { carreauInField?: boolean }).carreauInField;
    if (isTextField(t)) {
      const chord = this.mode === "off" && e.code === activation.code && this.modifierHeld(e);
      if (!chord || !this.view.el.contains(t!)) return this.shortcut(e, true);
    }
    if (e.key === activation.modifier) return; // the modifier itself (incl. autorepeat)

    if (this.mode === "off") {
      if (e.code === activation.code && this.modifierHeld(e) && !e.repeat) {
        e.preventDefault();
        this.setMode("held");
        return;
      }
      return this.shortcut(e, inField);
    }

    if (e.code === activation.code) {
      e.preventDefault();
      if (e.repeat) return;
      // Activation key again: while still holding the modifier, become sticky; when sticky,
      // leave navigation mode.
      if (this.mode === "held") this.setMode("sticky");
      else this.setMode("off");
      return;
    }
    if (e.key === "Escape" && this.mode === "sticky") {
      e.preventDefault();
      this.setMode("off");
      return;
    }

    // A modifier pressed on its own (e.g. Shift, before Shift+←) is not a key of its own.
    if (/^(Alt|Control|Meta|Shift)(Left|Right)$/.test(e.code)) return;
    const chord = this.chord(e);
    // A pending prefix: look the key up in the prefix's table.
    if (this.prefix) {
      if (e.repeat && chord === this.prefix) {
        e.preventDefault();
        return;
      }
      // Modifiers of the prefix's own chord may still be held (Shift+X, then Shift+←): ignore them.
      const table = lookup(this.config.prefixes, this.prefix);
      const prefixMods = this.prefix.split("+").slice(0, -1);
      const bare = chord.split("+").filter((p) => !prefixMods.includes(p)).join("+");
      const action = lookup(table, chord) ?? lookup(table, bare);
      e.preventDefault();
      e.stopPropagation();
      if (action) {
        this.run(action);
        this.prefixUsed = true;
        // One-shot unless the prefix key is still held down.
        if (!this.prefixHeld) this.clearPrefix();
      } else {
        this.clearPrefix(); // any other key cancels the prefix
      }
      return;
    }
    if (lookup(this.config.prefixes, chord)) {
      e.preventDefault();
      e.stopPropagation();
      this.prefix = chord;
      this.prefixHeld = true;
      this.prefixUsed = false;
      this.emitChange();
      return;
    }

    const action = lookup(this.config.bindings, chord);
    if (!action) return this.shortcut(e, inField);
    e.preventDefault();
    e.stopPropagation();
    this.run(action);
  }

  /** A shortcut for this key, if any (see `NavConfig.shortcuts`): run it. */
  private shortcut(e: KeyboardEvent, inField: boolean): void {
    if (/^(Alt|Control|Meta|Shift)(Left|Right)$/.test(e.code)) return;
    const found = lookup(this.config.shortcuts, fullChord(e));
    if (!found) return;
    const s = typeof found === "object" ? found : { run: found };
    if (inField && !s.inFields) return;
    e.preventDefault();
    e.stopPropagation();
    this.run(s.run);
  }

  private clearPrefix(): void {
    if (!this.prefix) return;
    this.prefix = null;
    this.prefixHeld = false;
    this.prefixUsed = false;
    this.emitChange();
  }

  private emitChange(): void {
    for (const fn of this.listeners) fn(this.mode);
  }

  private keyup(e: KeyboardEvent): void {
    this.heldMods.delete(e.code);
    // Releasing the prefix key: if it was used while held, it's done; otherwise it stays
    // pending for the next key (one-shot).
    if (this.prefix && e.code === this.prefix.split("+").pop()) {
      this.prefixHeld = false;
      if (this.prefixUsed) this.clearPrefix();
    }
    if (this.mode === "held" && this.isActivationModifierKey(e)) {
      // On Windows/Linux, releasing a bare Alt focuses the browser's menu bar: not here.
      e.preventDefault();
      this.setMode("off");
    }
  }

  /** The node cell operations act on (see `Workspace.operand`). */
  private operand() {
    const op = this.ws.operand();
    return op && !op.range ? this.ws.node(op.id) : null;
  }

  /** Leave navigation mode (for commands that end it). `commit`: the focused cell takes the focus. */
  leave(commit = true): void {
    this.setMode("off", commit);
  }

  run(action: NavBinding): void {
    if (typeof action === "function") return action({ ws: this.ws, view: this.view, nav: this });
    const ws = this.ws;
    switch (action) {
      case "toggleMaximize":
        ws.toggleMaximize();
        return;
      // Cell operations act on the operand: usually the selection (see `Workspace.operand`).
      case "float": {
        const n = this.operand();
        if (n?.type === "pane") this.view.floatPane(n.id);
        return;
      }
      case "group":
        // Group now, then edit the new tab's title in place (keys typed in the field are
        // ignored by this controller).
        this.view.groupAndName();
        return;
      case "renameTab": {
        const n = this.operand();
        if (n?.type === "pane") {
          const tab = (n as PaneNode).tabs[(n as PaneNode).active];
          if (tab) this.view.editTabTitle(tab.id);
        }
        return;
      }
      case "collapse":
        ws.collapse();
        return;
      case "closeTab": {
        const n = this.operand();
        if (n?.type === "pane") {
          const tab = (n as PaneNode).tabs[(n as PaneNode).active];
          if (tab) ws.closeTab(tab.id);
        }
        return;
      }
      case "closePane": {
        const n = this.operand();
        if (n) ws.closePane(n.id);
        return;
      }
      case "growWidth":
      case "shrinkWidth":
      case "growHeight":
      case "shrinkHeight": {
        const axis = action.endsWith("Width") ? "row" : "column";
        // (A cell's current size, when it has none of its own: measured.)
        ws.resizeFocus(axis, action.startsWith("grow") ? 1 : -1, (id) => {
          const r = this.view.pxRect(id);
          return r && (axis === "row" ? r.w : r.h);
        });
        return;
      }
      case "mark":
        ws.toggleMark();
        return;
      case "moveMarked":
        ws.moveMarked();
        return;
      case "namePane": {
        const n = this.operand();
        if (n?.type === "pane") this.view.editPaneName(n.id);
        return;
      }
      case "clear":
        void ws.clear();
        return;
      case "insertInto":
        // Into the focused cell's tabs (a split: its most recently focused pane's).
        ws.spawn({ split: "tab" });
        return;
      default: {
        const m = /^(insert|move)(Into)?(Left|Right|Up|Down)$/.exec(action);
        if (!m) return ws.run(action as Command);
        const { side, dir } = DIRS[m[3] as Dir];
        // Into a neighbour's tabs: if there is none on that side, where it would be.
        const spec = m[2] ? { split: "tab" as const, base: dir, force: true } : { split: side };
        if (m[1] === "insert") ws.spawn(spec);
        else ws.moveTab(spec);
      }
    }
  }
}
