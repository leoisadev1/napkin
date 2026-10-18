/** One ledger belongs to one speaking stretch, including its pipelined requests. */
export type Question = { id: string; text: string; status: 'answering' | 'answered' };
export const questionPolicyPrefix = 'Question ownership: ';
export class StretchQuestions {
  private questions: Question[] = [];
  private consumed = 0;
  private key = crypto.randomUUID().slice(0, 8);
  claim(stretch: string, boardHasTopic: boolean) {
    const remaining = stretch.slice(this.consumed).trimStart();
    const offset = stretch.length - remaining.length;
    const completed = [...remaining.matchAll(/[^?]+\?/g)];
    // Interrogative speech without its closing punctuation is still an open question.
    const comparisonComplete = !/\bcompare\b/i.test(remaining)
      || /\bcompare\s+.+\b(?:and|vs\.?|versus|with|to)\s+\S/i.test(remaining)
      || /\bcompare\s+(?:these|those|the|our)\s+\S+/i.test(remaining);
    const imperative = comparisonComplete && /\b(?:brainstorm|compare|recommend|suggest|give me|show me|come up with|think of|experiment with|play with|play around with|try (?:out )?some|list (?:some|a few|out|me)|generate|name (?:it|this|the)|help me|explore)\b|\bsome (?:names|ideas|options|titles|taglines|slogans|logos|angles|concepts)\b/i.test(remaining)
      && !/\b(?:do you|can you|could you|what|which|how|would you)\b/i.test(remaining)
      && !/\b(?:and|or|for|with|a|an|the|to)\s*$/i.test(remaining);
    const candidates = completed.length ? completed.map(match => ({ text: match[0].trim(), end: offset + match.index + match[0].length })) : imperative ? [{ text: remaining, end: stretch.length }] : [];
    const knownTopic = boardHasTopic || /\b(?:app|game|service|system|tracker|tracking|website|site|screen|database|editor|platform|product|podcast|show|channel|newsletter|brand|company|startup|business|book|video|course|blog|band|tool|extension|bot|store|shop|restaurant|event|community|feature|campaign|episode)s?\b/i.test(stretch)
      || /\b(?:this is|it's|it is|we're building|i'm building|building|making)\s+(?:like\s+|kind of\s+)?(?:a|an|my|our)\s+\w+/i.test(stretch)
      || candidates.some(({ text }) => /\b(?:for|about|between|compare)\s+\S+/i.test(text));
    const answer: Question[] = [];
    if (knownTopic) for (const { text, end } of candidates) {
      const question: Question = { id: `answer-${this.key}-${this.questions.length + 1}`, text: text.slice(-1600), status: 'answering' };
      this.questions.push(question); answer.push(question); this.consumed = end;
    }
    return this.policy(answer);
  }
  /** A claimed question that no request has drawn an answer for yet. */
  hasOpen() { return this.questions.some(question => question.status === 'answering'); }
  complete(ids: string[]) { for (const question of this.questions) if (ids.includes(question.id)) question.status = 'answered'; }
  policy(answer: Question[] = []) {
    const existing = this.questions.filter(question => !answer.includes(question)).slice(-4);
    // Keep the ownership message within ChatTurn's 4,000-character wire limit.
    const limit = Math.max(40, Math.floor(2600 / Math.max(1, answer.length + existing.length)));
    const compact = (question: Question) => ({ ...question, text: question.text.slice(-limit) });
    return questionPolicyPrefix + JSON.stringify({ answer: answer.map(compact), existing: existing.map(compact) });
  }
}
