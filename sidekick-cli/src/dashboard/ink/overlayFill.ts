/**
 * Background for the boxes drawn over the dashboard (toasts, the actions menu,
 * the accounts overlay).
 *
 * Ink paints only the cells a box's text covers, so padding and the ends of
 * short rows stayed transparent and the text underneath showed through. A box
 * with a background colour is first filled with spaces, and for a colour name
 * Ink does not recognise those spaces are written unstyled: the box becomes
 * opaque without assuming the terminal's own background colour (any real
 * colour would be wrong on some theme). Pinned by a frame test, since it relies
 * on how Ink treats an unknown colour.
 */
export const OVERLAY_FILL = 'none';
