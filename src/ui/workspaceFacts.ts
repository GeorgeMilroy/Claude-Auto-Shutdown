// Facts about this editor window that more than one part of the glue asks for.

import * as vscode from 'vscode';

/** Files with unsaved changes in this window (named in the confirmation of a real shut down). */
export function unsavedFiles(): number {
  return vscode.workspace.textDocuments.filter((document) => document.isDirty).length;
}
