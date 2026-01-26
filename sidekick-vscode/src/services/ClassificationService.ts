/**
 * @fileoverview ClassificationService - Content type classification using Claude Haiku.
 *
 * ClassificationService classifies text as prose, technical, or code for adaptive explanations.
 * Uses Haiku for speed and cost efficiency (~$0.001/request, <500ms).
 *
 * @module ClassificationService
 */

import { AuthService } from './AuthService';
import type { ContentType } from '../types/rsvp';

/**
 * ClassificationService - Content type classification using Claude Haiku.
 *
 * Classifies text as prose, technical, or code for adaptive explanations.
 * Uses Haiku for speed and cost efficiency (~$0.001/request, <500ms).
 */
export class ClassificationService {
  /**
   * Creates a new ClassificationService.
   *
   * @param authService - AuthService instance for Claude API access
   */
  constructor(private authService: AuthService) {}

  /**
   * Classify text content type.
   *
   * Uses Claude Haiku to quickly categorize content. Falls back to heuristic
   * classification if the API call fails or returns an unexpected result.
   *
   * @param text - Text to classify
   * @returns Promise resolving to 'prose', 'technical', or 'code'
   */
  async classify(text: string): Promise<ContentType> {
    try {
      const prompt = `Classify the following text into exactly one category: prose, technical, or code.

Rules:
- "prose": Natural language text, stories, articles, documentation without code
- "technical": Technical documentation with concepts, but no actual code snippets
- "code": Contains actual programming code, functions, classes, or code snippets

Text to classify:
<text>
${text}
</text>

Output ONLY the category word (prose, technical, or code). No explanation.`;

      const response = await this.authService.complete(prompt, {
        model: 'haiku',
        maxTokens: 10,
        timeout: 30000, // SDK needs ~3s to init
      });

      // Validate response is one of the three expected categories
      const normalized = response.trim().toLowerCase();
      if (normalized === 'prose' || normalized === 'technical' || normalized === 'code') {
        return normalized as ContentType;
      }

      // Unexpected response - fall back to heuristic
      console.warn(`Unexpected classification response: "${response}". Using heuristic fallback.`);
      return this.heuristicClassification(text);
    } catch (error) {
      // API error - fall back to heuristic
      console.error('Classification error, using heuristic fallback:', error);
      return this.heuristicClassification(text);
    }
  }

  /**
   * Heuristic classification fallback.
   *
   * Simple pattern-based classification when API is unavailable or returns
   * unexpected results.
   *
   * @param text - Text to classify
   * @returns ContentType based on pattern matching
   */
  private heuristicClassification(text: string): ContentType {
    // Check for code indicators
    const codePattern = /^[\s]*(function|class|const|let|var|import|export|def|public|private)/m;
    if (codePattern.test(text)) {
      return 'code';
    }

    // Check for technical indicators with sufficient length
    const technicalPattern = /(algorithm|compile|database|API|framework|protocol|syntax)/i;
    if (technicalPattern.test(text) && text.length > 200) {
      return 'technical';
    }

    // Default to prose
    return 'prose';
  }
}
