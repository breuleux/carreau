// Demo cell classes: what a cell creates when the user inserts a new cell from it
// (navigation mode: I, then a direction, with or without Shift), and what it does with the
// keyboard focus when navigation mode ends on it. The host decides; this is the demo's take.

import { cell, PROMPT, SHELL, stateful, t, youtube } from "./examples";
import { Tab } from "../src/model";

interface CellClass {
  name: string;
  matches(tab: Tab): boolean;
  spawn(from: Tab): Tab;
  /** Take the keyboard focus (navigation mode ends on this cell). Default: nothing. */
  commitFocus?(tab: Tab, content: HTMLElement | null): void;
}

const frameIn = (content: HTMLElement | null) => content?.querySelector("iframe") ?? null;

const pick = <T>(xs: T[]): T => xs[Math.floor(Math.random() * xs.length)];
let counter = 0;

const COMMANDS: [string, string][] = [
  ["pwd", "/home/olivier/bu/carreau"],
  ["whoami", "olivier"],
  ["date", new Date().toString()],
  ["git status", "On branch main\nnothing to commit, working tree clean"],
  ["ls src", "cells.ts  colors.ts  dnd.ts  examples.ts  geometry.ts  keyboard.ts  kinds.ts\nmain.ts  model.ts  tree.ts  types.ts  view.ts  workspace.ts"],
  ["uptime", "10:42  up 3 days,  2:17, 2 users, load averages: 1.52 1.61 1.70"],
  ["wc -l src/*.ts", "  3812 total"],
  ["echo $SHELL", "/bin/zsh"],
];

const FOLLOW_UPS: [string, string][] = [
  ["Shorter", "Make it shorter."],
  ["Example", "Give an example."],
  ["Why", "Why is that?"],
  ["Rephrase", "Say it differently."],
];

const VIDEOS: [string, string][] = [
  ["Big Buck Bunny", "aqz-KE-bpKQ"],
  ["Me at the zoo", "jNQXAC9IVRw"],
];

const CLASSES: CellClass[] = [
  {
    // A shell cell: another command in the same shell.
    name: "shell",
    matches: (tab) => !!tab.long?.startsWith("$") || tab.icon === SHELL,
    spawn: (from) => {
      const [cmd, out] = pick(COMMANDS);
      return cell(cmd.split(" ")[0], SHELL, `$ ${cmd}`, from.accent ?? "oklch(0.75 0.12 160)", "done", out);
    },
  },
  {
    // A prompt: a follow-up prompt.
    name: "prompt",
    matches: (tab) => tab.icon === PROMPT,
    spawn: (from) => {
      const [short, prompt] = pick(FOLLOW_UPS);
      return cell(short, PROMPT, prompt, from.accent ?? "oklch(0.72 0.13 300)", undefined, `(an answer to "${prompt}")`);
    },
  },
  {
    // A video: another video.
    name: "video",
    matches: (tab) => typeof tab.data?.youtube === "string",
    spawn: () => youtube(...pick(VIDEOS)),
    // The player gets the keys (space: play/pause). Cross-origin: Alt+Q can't get out of it;
    // click outside instead.
    commitFocus: (_, content) => frameIn(content)?.focus(),
  },
  {
    // A page with state: a new instance of it.
    name: "page",
    matches: (tab) => typeof tab.data?.srcdoc === "string",
    spawn: () => stateful(`Counter ${String.fromCharCode(67 + (counter++ % 24))}`),
    // Straight into its text field. (Its keys are bridged: Alt+Q gets out.)
    commitFocus: (_, content) => {
      const f = frameIn(content);
      const input = f?.contentDocument?.querySelector("input");
      if (input) input.focus();
      else f?.focus();
    },
  },
  {
    // Anything else (including groups): a text tab.
    name: "text",
    matches: () => true,
    spawn: () => t(`Untitled ${++counter}`, 1),
  },
];

/** The class of a cell. */
const classOf = (tab: Tab) => CLASSES.find((c) => c.matches(tab))!;

/** Leaving navigation mode on a cell. */
export function commitCellFocus(tab: Tab, content: HTMLElement | null): void {
  classOf(tab).commitFocus?.(tab, content);
}

/** The new cell `from` creates. */
export function spawnCell(from: Tab): Tab {
  return classOf(from).spawn(from);
}
