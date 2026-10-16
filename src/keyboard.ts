// Keyboard navigation mode.
//
// An activation chord (e.g. Alt+Q) enters navigation mode for as long as the modifier is
// held. Pressing the activation key again while still holding the modifier (Alt+Q, Q) makes
// the mode sticky: it then lasts until the activation key (or Escape) is pressed again.
// While in navigation mode, plain keys (with the activation modifier held or not) run
// actions. Nothing is hard-coded: the activation chord and all bindings come from the config.

import { PaneNode } from "./model";
import { View } from "./view";
import { Command, Workspace } from "./workspace";

export type NavAction = Command | "toggleMaximize" | "float" | "closeTab" | "closePane" | "group" | "collapse" | "renameTab";

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
  bindings: Record<string, NavAction>;
  /**
   * Prefix keys: after a prefix key (same chord syntax), the next key is looked up in its own
   * table. Holding the prefix key down keeps it active for every key pressed meanwhile.
   * E.g. `{ KeyS: { ArrowLeft: "swapLeft", … } }` makes S then ← swap left.
   */
  prefixes?: Record<string, Record<string, NavAction>>;
}

export type NavMode = "off" | "held" | "sticky";

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
      if (this.mode === "held") this.setMode("off");
    });
  }

  onChange(fn: (mode: NavMode) => void): void {
    this.listeners.push(fn);
  }

  private setMode(mode: NavMode): void {
    if (mode === "off") this.clearPrefix();
    if (mode === this.mode) return;
    // Multi-selections only live within navigation mode.
    if (mode === "off") this.ws.clearMultiSelection();
    this.mode = mode;
    this.view.setNavMode(mode);
    for (const fn of this.listeners) fn(mode);
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
    // Typing in a text field (e.g. the group name prompt) is not navigation.
    const t = e.target as HTMLElement | null;
    if (t && (t.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(t.tagName))) return;
    if (e.key === activation.modifier) return; // the modifier itself (incl. autorepeat)

    if (this.mode === "off") {
      if (e.code === activation.code && this.modifierHeld(e) && !e.repeat) {
        e.preventDefault();
        this.setMode("held");
      }
      return;
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

    const chord = this.chord(e);
    // A pending prefix: look the key up in the prefix's table.
    if (this.prefix) {
      if (e.repeat && chord === this.prefix) {
        e.preventDefault();
        return;
      }
      const action = this.config.prefixes?.[this.prefix]?.[chord];
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
    if (this.config.prefixes?.[chord]) {
      e.preventDefault();
      e.stopPropagation();
      this.prefix = chord;
      this.prefixHeld = true;
      this.prefixUsed = false;
      this.emitChange();
      return;
    }

    const action = this.config.bindings[chord];
    if (!action) return;
    e.preventDefault();
    e.stopPropagation();
    this.run(action);
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

  run(action: NavAction): void {
    const ws = this.ws;
    switch (action) {
      case "toggleMaximize":
        ws.toggleMaximize();
        return;
      case "float": {
        const n = ws.node(ws.selection.id);
        if (n?.type === "pane") this.view.floatPane(n.id);
        return;
      }
      case "group":
        // Group now, then edit the new tab's title in place (keys typed in the field are
        // ignored by this controller).
        this.view.groupAndName();
        return;
      case "renameTab": {
        const n = ws.node(ws.selection.id);
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
        const n = ws.node(ws.selection.id);
        if (n?.type === "pane") {
          const tab = (n as PaneNode).tabs[(n as PaneNode).active];
          if (tab) ws.closeTab(tab.id);
        }
        return;
      }
      case "closePane":
        ws.closePane(ws.selection.id);
        return;
      default:
        ws.run(action);
    }
  }
}
