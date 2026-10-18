import { z } from 'zod';
import type { AgentRequest } from '../shared/agent-protocol';
import type { BoardOp } from '../shared/board';
import { NodeId } from '../shared/board';
import { concise } from './concision';
import { questionPolicyPrefix, StretchQuestions } from '../src/conversation/engine/questions';

const Question = z.object({ id: NodeId, text: z.string(), status: z.enum(['answering', 'answered']) });
const Policy = z.object({ answer: z.array(Question), existing: z.array(Question) });
const generic = /underserved audience|reverse a norm|unexpected pairing|one painful task|useful constraint/i;
const requestSticky = /(?:explore|brainstorm|find|discuss) (?:a |some |the )?(?:distinctive|unique|different|new)?\s*(?:angle|idea)|\b(?:explore|brainstorm|discuss)\s+(?:a|an|the)\s*$|do you have|could we|possibly take/i;
const filler = new Set('the and for are can you have any about could would some that possibly take unique angles what which with there thinking should use app game service system tracking brainstorm ideas give show please'.split(' '));

/** Request-local enforcement; the engine supplies ownership across parallel calls. */
export function answerGuard(input: AgentRequest) {
  const stretch = input.history.findLast(turn => turn.text.startsWith('Whole current speaking stretch'))?.text.replace(/^.*?: /, '') ?? input.utterance;
  const marker = input.history.findLast(turn => turn.text.startsWith(questionPolicyPrefix));
  let policy: z.infer<typeof Policy>;
  try {
    policy = Policy.parse(JSON.parse(marker?.text.slice(questionPolicyPrefix.length) ?? new StretchQuestions().claim(stretch, input.board.items.some(item => !!item.label)).slice(questionPolicyPrefix.length)));
  } catch { policy = { answer: [], existing: [] }; }
  const questions = input.mode === 'refine' ? [...policy.answer, ...policy.existing] : policy.answer;
  const questionContext = !!questions.length || !!policy.existing.length || /\b(?:do you|can you|could you|what|which|how|unique angles|brainstorm|recommend|suggest|give me|compare)\b/i.test(stretch);
  const items = input.board.items;
  const states = questions.map(question => {
    const topicWords = [...new Set((question.text.toLowerCase().match(/[a-z]{3,}/g) ?? []).filter(word => !filler.has(word)))];
    const score = (text: string) => topicWords.filter(word => text.toLowerCase().includes(word)).length;
    const candidates = items.filter(item => {
      if (item.origin !== 'agent' || item.kind !== 'diagram') return false;
      if (item.id === question.id) return true;
      // Reserved IDs belong to their own question, even when topics overlap.
      if (marker || questions.length > 1) return false;
      const isGeneric = generic.test([item.label, ...items.filter(child => child.frame === item.id).map(child => child.label)].join(' '));
      const answerTitle = /angle|option|idea|approach|compar|recommend|answer|alternativ|choice|framework/i.test(item.label);
      const topiclessTitle = item.label.toLowerCase().split(/\W+/).filter(Boolean).every(word => /^(?:unique|distinctive|different|new|possible|angles?|options?|ideas?|approaches|framework|brainstorm|brainstorming|a|an|the)$/.test(word));
      return (answerTitle && score(item.label) > 0) || (isGeneric && topiclessTitle && /angle|idea|brainstorm/i.test(question.text));
    }).sort((a, b) => Number(b.id === question.id) - Number(a.id === question.id) || score(b.label) - score(a.label));
    const diagramId = candidates[0]?.id ?? question.id;
    const optionLabels = items.filter(item => candidates.some(diagram => item.frame === diagram.id)).map(item => item.label.toLowerCase().split(/[\s:]+/)[0] ?? '');
    const preferredOptions = items.filter(item => item.frame === candidates[0]?.id).map(item => item.label.toLowerCase().split(/[\s:]+/)[0] ?? '');
    const preferredPick = (label: string) => preferredOptions.some(option => option.length > 4 && label.toLowerCase().includes(option));
    const picks = items.filter(item => item.origin === 'agent' && /^Pick\s*:/i.test(item.label) && (
      item.id === `${question.id}-pick` || (marker && item.id.startsWith('answer-') ? false : score(item.label) > 0 || optionLabels.some(label => label.length > 4 && item.label.toLowerCase().includes(label)))
    )).sort((a, b) => Number(preferredPick(b.label)) - Number(preferredPick(a.label)));
    const pickId = picks[0]?.id ?? `${diagramId.slice(0, 43)}-pick`;
    const related = items.find(item => item.origin === 'user' && score(item.label) > 0)
      ?? items.find(item => !['edge', 'diagram'].includes(item.kind) && !item.frame && !/^Pick\s*:/i.test(item.label) && score(item.label) > 0);
    const cleanup = new Set<string>();
    if (input.mode === 'refine') {
      for (const duplicate of candidates.slice(1)) {
        cleanup.add(duplicate.id); items.filter(item => item.frame === duplicate.id).forEach(item => cleanup.add(item.id));
      }
      picks.slice(1).forEach(item => cleanup.add(item.id));
      items.filter(item => item.origin === 'agent' && item.kind === 'shape' && score(item.label) > 0 && requestSticky.test(item.label)).forEach(item => cleanup.add(item.id));
    }
    return { question, diagramId, pickId, related, cleanup, hasDiagram: candidates.length > 0, emittedDiagram: false, emittedPick: false };
  });
  const instructions = !questionContext ? '' : states.length
    ? states.map(state => `\nANSWER question ${JSON.stringify(state.question.text)} using diagram ID ${state.diagramId}. ENRICH or REPLACE that same ID; never add another answer. Pick sticky ID ${state.pickId}, near:${state.diagramId}:below. ${state.related ? `Answer placement near:${state.related.id}:right.` : ''} Delete superseded generic answers and extra Pick stickies. Answer diagrams MUST use the assigned diagram ID exactly, never an arbitrary ID. Ordinary descriptive diagrams use their own IDs. Topic must be explicit in the diagram title. No generic framework answers.`).join('')
    : `\nDo not answer questions in this request. ${policy.existing.map(question => `The question ${JSON.stringify(question.text)} is ${question.status === 'answering' ? 'being answered by a parallel request' : 'already answered'}; don't answer it.`).join(' ') || 'The question is incomplete or its topic is unknown; wait for the completing NEW words.'} Do draw concrete ideas, flows, screens and corrections from NEW words; this restriction applies only to recommendations for that same question. Draw no generic answer or request-restating sticky.`;
  const replacementIds = new Set<string>();
  return {
    instructions,
    cleanup(): BoardOp[] { const ids = [...new Set(states.filter(state => state.emittedDiagram).flatMap(state => [...state.cleanup].filter(id => !replacementIds.has(id))))]; return ids.length ? [{ op: 'delete', ids }] : []; },
    operation(op: BoardOp): BoardOp | undefined {
      if (marker && 'id' in op && op.id.startsWith('answer-') && !states.some(state => state.diagramId === op.id || state.pickId === op.id)) return;
      if (op.op === 'add_shape' && op.shape === 'sticky' && requestSticky.test(op.label)) return;
      if (op.op === 'update' && op.label !== undefined) {
        const item = items.find(item => item.id === op.id);
        return { ...op, label: concise(op.label, item?.kind === 'edge' ? 3 : /^Pick\s*:/i.test(item?.label ?? '') ? 14 : 6, item?.kind === 'edge' ? 60 : 200) };
      }
      if (!questionContext) return op;
      if (op.op === 'add_shape' && generic.test(op.label)) return;
      if (op.op === 'add_diagram') {
        const isAnswer = op.id.startsWith('answer-') || states.some(state => state.diagramId === op.id) || !marker && /angle|option|idea|approach|compar|versus|\bvs\b|answer|alternativ|choice|framework/i.test(op.title);
        if (!isAnswer) return op;
        const state = states.find(state => state.diagramId === op.id) ?? (!marker ? states.find(state => !state.emittedDiagram) : undefined);
        if (!state || state.emittedDiagram || generic.test(op.nodes.map(node => node.label).join(' '))) return;
        state.emittedDiagram = true;
        replacementIds.add(state.diagramId); op.nodes.forEach(node => replacementIds.add(node.id));
        return { ...op, id: state.diagramId, placement: state.hasDiagram ? { kind: 'at', target: state.diagramId } : state.related ? { kind: 'near', target: state.related.id, direction: 'right' } : op.placement };
      }
      if (op.op === 'add_shape' && /^Pick\s*:/i.test(op.label)) {
        const state = states.find(state => state.pickId === op.id) ?? states.find(state => !state.emittedPick && (state.emittedDiagram || state.hasDiagram));
        if (!state || state.emittedPick || (!state.emittedDiagram && !state.hasDiagram)) return;
        state.emittedPick = true;
        return { ...op, id: state.pickId, placement: { kind: 'near', target: state.diagramId, direction: 'below' } };
      }
      return op;
    },
  };
}
