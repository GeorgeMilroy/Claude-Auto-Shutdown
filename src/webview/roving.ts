// Roving tabindex for the session list: the list is ONE tab stop, and the arrow keys move between
// its rows.

/** What a key pressed on a session row asks for; null = not a list key (leave it to the browser). */
export type RowKeyIntent = { move: number } | { expand: boolean } | null;

/**
 * `index` = the focused row, `count` = rows in the list, `expanded` = that row is open.
 * Up / Down / Home / End move; Right opens; Left closes. Enter and Space are the button's own
 * click and are not handled here.
 */
export function rowKeyIntent(key: string, index: number, count: number, expanded: boolean): RowKeyIntent {
  if (count <= 0 || index < 0 || index >= count) return null;
  switch (key) {
    case 'ArrowDown':
      return index + 1 < count ? { move: index + 1 } : null;
    case 'ArrowUp':
      return index > 0 ? { move: index - 1 } : null;
    case 'Home':
      return index === 0 ? null : { move: 0 };
    case 'End':
      return index === count - 1 ? null : { move: count - 1 };
    case 'ArrowRight':
      return expanded ? null : { expand: true };
    case 'ArrowLeft':
      return expanded ? { expand: false } : null;
    default:
      return null;
  }
}

/** The row that holds the list's single tab stop: the remembered one if it still exists, else the first. */
export function tabStopIndex(keys: readonly string[], rememberedKey: string | null): number {
  const index = rememberedKey === null ? -1 : keys.indexOf(rememberedKey);
  return index === -1 ? 0 : index;
}
