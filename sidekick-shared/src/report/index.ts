/**
 * Public API for the report module.
 */

export type { TranscriptContentBlock, TranscriptEntry, HtmlReportOptions } from './types';
export { parseTranscript } from './transcriptParser';
export { generateHtmlReport } from './htmlReportGenerator';
export { openInBrowser } from './openBrowser';
export { escapeHtml, simpleMarkdownToHtml, highlightCodeBlock } from './htmlHelpers';
