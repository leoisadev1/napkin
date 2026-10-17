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
    const imperative = comparisonComplete && /\b(?:brainstorm|compare|recommend|suggest|give me|show me)\b/i.test(remaining)
      && !/\b(?:do you|can you|could you|what|which|how|would you)\b/i.test(remaining)
      && !/\b(?:and|or|for|with|a|an|the|to)\s*$/i.test(remaining);
    const candidates = completed.length ? completed.map(match => ({ text: match[0].trim(), end: offset + match.index + match[0].length })) : imperative ? [{ text: remaining, end: stretch.length }] : [];
    const knownTopic = boardHasTopic || /\b(?:app|game|service|system|tracker|tracking|website|screen|database|editor|platform|product)\b/i.test(stretch)
      || candidates.some(({ text }) => /\b(?:for|about|between|compare)\s+\S+/i.test(text));
    const answer: Question[] = [];
    if (knownTopic) for (const { text, end } of candidates) {
      const question: Question = { id: `answer-${this.key}-${this.questions.length + 1}`, text: text.slice(-1600), status: 'answering' };
      this.questions.push(question); answer.push(question); this.consumed = end;
    }
    return this.policy(answer);
  }
  complete(ids: string[]) { for (const question of this.questions) if (ids.includes(question.id)) question.status = 'answered'; }
  policy(answer: Question[] = []) {
    const existing = this.questions.filter(question => !answer.includes(question)).slice(-4);
    // Keep the ownership message within ChatTurn's 4,000-character wire limit.
    const limit = Math.max(40, Math.floor(2600 / Math.max(1, answer.length + existing.length)));
    const compact = (question: Question) => ({ ...question, text: question.text.slice(-limit) });
    return questionPolicyPrefix + JSON.stringify({ answer: answer.map(compact), existing: existing.map(compact) });
  }
}
