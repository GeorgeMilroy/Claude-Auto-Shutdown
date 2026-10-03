// Tooltips are Markdown, and what goes into them (session names, folder names, OS error texts,
// the label of another window) was written by somebody else. Every such value is escaped, and
// the only links a tooltip may carry are built here from this extension's own command ids.
//
// Notifications and dialogs are not Markdown, but the editor still turns `[label](command:…)` in
// their text into a link that runs the command - and their text quotes the same untrusted values.

const ASCII_PUNCTUATION = /[!-/:-@[-`{-~]/g;

/** One line of plain text as Markdown source: no formatting, no links, no HTML, no line breaks. */
export function escapeMarkdown(text: string): string {
  return text.replace(/\s+/g, ' ').trim().replace(ASCII_PUNCTUATION, '\\$&');
}

/** `[label](command:id)`. The id is one of ours; the label is escaped like any other text. */
export function commandLink(label: string, commandId: string): string {
  return `[${escapeMarkdown(label)}](command:${commandId})`;
}

/**
 * Text for a notification, a progress notification or a dialog, with no link left in it.
 *
 * The editor's parser links only `[label](target)` with nothing between `]` and `(`, and shows
 * everything else - backslashes included - as it is. None of our messages carries a link, so a
 * backslash goes between every `]` and `(`: that ends the link for this parser and for Markdown
 * alike, and leaves every other character (the parentheses of "Project (1)") untouched.
 */
export function plainMessage(text: string): string {
  return text.replace(/\](?=\()/g, ']\\');
}
