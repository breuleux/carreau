// Public API.
//
// Styles are not imported here: import "carreau/style.css" (and "carreau/prompt.css" when
// using prompts) from the host app. Prompt *rendering* is optional as well: import
// "carreau/prompt-view" (or register a renderer for "prompt" yourself).

declare const __CARREAU_VERSION__: string;
/** The version of this package (its `package.json` at build time). */
export const VERSION: string = __CARREAU_VERSION__;

export * from "./cells";
export * from "./colors";
export * from "./complex";
export * from "./dnd";
export * from "./geometry";
export * from "./keyboard";
export * from "./kinds";
export * from "./model";
export * from "./prompt";
export * from "./tree";
export * from "./types";
export * from "./view";
export * from "./workspace";
