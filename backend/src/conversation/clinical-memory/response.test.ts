import { describe, expect, it } from 'vitest';
import { BANNED_SEVERITY_TERMS } from '@medadhere/shared';
import {
  clinicalResponsePlanSchema,
  needFieldSchema,
  type ClinicalResponsePlan,
} from './contracts.js';
import {
  ACKNOWLEDGEMENT_ORIENTATION,
  CLINICAL_RENDERER_VERSION,
  EXPLAINERS,
  renderClinicalResponse,
  renderParsedClinicalResponse,
} from './response.js';

const MAX_SMS_RESPONSE_CHARS = 320;

const routinePlan: ClinicalResponsePlan = { kind: 'routine', reviewReasons: [] };

const severityQuestionPlan: ClinicalResponsePlan = {
  kind: 'question',
  question: {
    needId: 'need-severity',
    eventId: 'event-nausea',
    field: 'severity',
    questionId: 'question-severity',
    targetLabel: 'nausea',
  },
  reviewReasons: [],
};

const medicationIdentityQuestionPlan: ClinicalResponsePlan = {
  kind: 'question',
  question: {
    needId: 'need-medication',
    eventId: 'event-dose',
    field: 'medication_identity',
    questionId: 'question-medication',
  },
  reviewReasons: [],
};

/** Injects the cross-lane optional `reask` flag the planner lane adds to the contracts schema. */
function withReask(plan: ClinicalResponsePlan): ClinicalResponsePlan {
  if (plan.question === undefined) throw new Error('reask_requires_question');
  return {
    ...plan,
    question: { ...plan.question, reask: true },
  } as unknown as ClinicalResponsePlan;
}

describe('renderClinicalResponse — existing template pins (byte-for-byte)', () => {
  it('pins the emergency template', () => {
    expect(renderClinicalResponse({ kind: 'emergency', reviewReasons: [] })).toBe(
      'MedAdhere: thank you for your message. If you need help right away, call 911. ' +
        'To talk with someone about how you are feeling, call or text 988 any time.',
    );
  });

  it('pins the stop template', () => {
    expect(renderClinicalResponse({ kind: 'stop', reviewReasons: [] })).toBe(
      'You are unsubscribed and will not receive more MedAdhere messages.',
    );
  });

  it('pins the unsupported-language template', () => {
    expect(renderClinicalResponse({ kind: 'unsupported_language', reviewReasons: [] })).toBe(
      'Thanks. I saved your message for your care team to review.',
    );
  });

  it('pins the stale-snapshot template', () => {
    expect(renderClinicalResponse({ kind: 'stale_snapshot', reviewReasons: [] })).toBe(
      'Thanks. Please send that update again.',
    );
  });

  it('pins the important and human-review templates', () => {
    const expected = 'Thanks. I saved this update for your doctor to review.';
    expect(renderClinicalResponse({ kind: 'important', reviewReasons: [] })).toBe(expected);
    expect(renderClinicalResponse({ kind: 'human_review', reviewReasons: [] })).toBe(expected);
  });

  it('pins the routine fallback template', () => {
    expect(renderClinicalResponse(routinePlan)).toBe('Thanks for letting me know.');
  });

  it('pins every question template', () => {
    expect(renderClinicalResponse(severityQuestionPlan)).toBe(
      'I’ve noted your update. For nausea, what number from 1 to 10 best describes the symptom’s intensity?',
    );
    expect(renderClinicalResponse(medicationIdentityQuestionPlan)).toBe(
      'I’ve noted your update. Which medication do you mean?',
    );
    expect(
      renderClinicalResponse({
        kind: 'question',
        question: {
          needId: 'need-time',
          eventId: 'event-dose',
          field: 'actual_time',
          questionId: 'question-time',
          targetLabel: 'metformin 8:00',
        },
        reviewReasons: [],
      }),
    ).toBe('I’ve noted your update. About what time did you take the metformin 8:00 dose?');
    expect(
      renderClinicalResponse({
        kind: 'question',
        question: {
          needId: 'need-duration',
          eventId: 'event-nausea',
          field: 'duration',
          questionId: 'question-duration',
          targetLabel: 'nausea',
        },
        reviewReasons: [],
      }),
    ).toBe('I’ve noted your update. For nausea, how long has this been happening?');
    expect(
      renderClinicalResponse({
        kind: 'question',
        question: {
          needId: 'need-site',
          eventId: 'event-rash',
          field: 'body_site',
          questionId: 'question-site',
          targetLabel: 'rash',
        },
        reviewReasons: [],
      }),
    ).toBe('I’ve noted your update. For rash, where on your body did you notice it?');
    expect(
      renderClinicalResponse({
        kind: 'question',
        question: {
          needId: 'need-frequency',
          eventId: 'event-headache',
          field: 'frequency',
          questionId: 'question-frequency',
          targetLabel: 'headache',
        },
        reviewReasons: [],
      }),
    ).toBe('I’ve noted your update. For headache, how often is this happening?');
    expect(
      renderClinicalResponse({
        kind: 'question',
        question: {
          needId: 'need-dose',
          eventId: 'event-dose',
          field: 'dose_identity',
          questionId: 'question-dose',
        },
        reviewReasons: [],
      }),
    ).toBe('I’ve noted your update. Which scheduled dose do you mean?');
    expect(
      renderClinicalResponse({
        kind: 'question',
        question: {
          needId: 'need-event',
          field: 'event_identity',
          questionId: 'question-event',
        },
        reviewReasons: [],
      }),
    ).toBe('I’ve noted your update. Which earlier report do you mean?');
    expect(
      renderClinicalResponse({
        kind: 'question',
        question: {
          needId: 'need-symptom',
          eventId: 'event-symptom',
          field: 'symptom_identity',
          questionId: 'question-symptom',
        },
        reviewReasons: [],
      }),
    ).toBe('I’ve noted your update. What symptom are you experiencing?');
  });
});

describe('orientation acknowledgement branch', () => {
  it('pins the orientation literal shared with the planner lane', () => {
    expect(ACKNOWLEDGEMENT_ORIENTATION).toBe('acknowledgement-orientation');
  });

  it('renders the mid-thread-safe fallback floor for acknowledgement-orientation, byte-for-byte', () => {
    expect(
      renderClinicalResponse({ ...routinePlan, acknowledgementId: ACKNOWLEDGEMENT_ORIENTATION }),
    ).toBe("All good — I'm around if you need anything.");
  });

  it('keeps the orientation text within the SMS response cap', () => {
    const rendered = renderClinicalResponse({
      ...routinePlan,
      acknowledgementId: ACKNOWLEDGEMENT_ORIENTATION,
    });
    expect(rendered.length).toBeLessThanOrEqual(MAX_SMS_RESPONSE_CHARS);
  });

  it('keeps the plain routine ack for any other acknowledgementId', () => {
    expect(
      renderClinicalResponse({ ...routinePlan, acknowledgementId: 'acknowledgement-other' }),
    ).toBe('Thanks for letting me know.');
  });

  it('never lets the orientation acknowledgement outrank a safety kind', () => {
    expect(
      renderClinicalResponse({
        kind: 'emergency',
        acknowledgementId: ACKNOWLEDGEMENT_ORIENTATION,
        reviewReasons: [],
      }),
    ).toBe(
      'MedAdhere: thank you for your message. If you need help right away, call 911. ' +
        'To talk with someone about how you are feeling, call or text 988 any time.',
    );
    expect(
      renderClinicalResponse({
        kind: 'human_review',
        acknowledgementId: ACKNOWLEDGEMENT_ORIENTATION,
        reviewReasons: ['clinical_context_changed'],
      }),
    ).toBe('Thanks. I saved this update for your doctor to review.');
  });
});

describe('re-ask branch (question + explainer when reask is true)', () => {
  // The strict contracts schema does not carry `reask` until the planner lane merges, so the
  // branch is exercised through the parse-free renderer with a typed cast (cross-lane contract).
  it('renders question + explainer for a label-required field, byte-for-byte', () => {
    expect(renderParsedClinicalResponse(withReask(severityQuestionPlan))).toBe(
      'Just following up on my earlier question. For nausea, what number from 1 to 10 best ' +
        'describes the symptom’s intensity? 1 means you barely notice it, 10 is the worst you ' +
        'have ever felt.',
    );
  });

  it('renders question + explainer for an identity field, byte-for-byte', () => {
    expect(renderParsedClinicalResponse(withReask(medicationIdentityQuestionPlan))).toBe(
      'Just following up on my earlier question. Which medication do you mean? ' +
        'You can reply with the medication name from your schedule.',
    );
  });

  it('renders the question alone when reask is absent or false', () => {
    expect(renderParsedClinicalResponse(severityQuestionPlan)).toBe(
      'I’ve noted your update. For nausea, what number from 1 to 10 best describes the symptom’s intensity?',
    );
    const explicitFalse = {
      ...severityQuestionPlan,
      question: { ...severityQuestionPlan.question, reask: false },
    } as unknown as ClinicalResponsePlan;
    expect(renderParsedClinicalResponse(explicitFalse)).toBe(
      'I’ve noted your update. For nausea, what number from 1 to 10 best describes the symptom’s intensity?',
    );
  });

  it('keeps every field’s re-ask within the SMS response cap for typical labels', () => {
    for (const field of needFieldSchema.options) {
      const plan = withReask({
        kind: 'question',
        question: {
          needId: 'need-1',
          ...(field === 'event_identity' ? {} : { eventId: 'event-1' }),
          field,
          questionId: 'question-1',
          targetLabel: 'hydrochlorothiazide 25 mg morning',
        },
        reviewReasons: [],
      } as ClinicalResponsePlan);
      expect(renderParsedClinicalResponse(plan).length).toBeLessThanOrEqual(MAX_SMS_RESPONSE_CHARS);
    }
  });

  it('routes the public renderer through the same parsed renderer', () => {
    expect(renderClinicalResponse(severityQuestionPlan)).toBe(
      renderParsedClinicalResponse(severityQuestionPlan),
    );
  });
});

describe('question render overflow degradation (hard 320-char responseText cap)', () => {
  // textSchema allows target labels up to 1000 chars (long combination-product ingredient
  // strings); an over-cap render would throw a ZodError OUTSIDE prepare's guarded region and
  // poison the turn, so the renderer must degrade deterministically instead.
  const hugeLabel = 'x'.repeat(400);

  function hugeLabelPlan(field: string, reask: boolean): ClinicalResponsePlan {
    const plan = {
      kind: 'question',
      question: {
        needId: 'need-1',
        ...(field === 'event_identity' ? {} : { eventId: 'event-1' }),
        field,
        questionId: 'question-1',
        targetLabel: hugeLabel,
        ...(reask ? { reask: true } : {}),
      },
      reviewReasons: [],
    } as unknown as ClinicalResponsePlan;
    return plan;
  }

  it('drops the oversize label from a re-ask, keeping the generic question and its explainer', () => {
    expect(renderParsedClinicalResponse(hugeLabelPlan('actual_time', true))).toBe(
      'Just following up on my earlier question. About what time did you take it? ' +
        'You can reply with an approximate time, like 8 in the morning.',
    );
  });

  it('drops the oversize label from a fresh ask, keeping the generic question', () => {
    expect(renderParsedClinicalResponse(hugeLabelPlan('severity', false))).toBe(
      'I’ve noted your update. What number from 1 to 10 best describes the symptom’s intensity?',
    );
  });

  it('never exceeds the cap for ANY field, ask or re-ask, at the schema-maximal label length', () => {
    for (const field of needFieldSchema.options) {
      for (const reask of [false, true]) {
        expect(
          renderParsedClinicalResponse(hugeLabelPlan(field, reask)).length,
        ).toBeLessThanOrEqual(MAX_SMS_RESPONSE_CHARS);
      }
    }
  });

  it('keeps the labeled text untouched whenever it fits the cap', () => {
    expect(renderParsedClinicalResponse(withReask(severityQuestionPlan))).toContain('For nausea,');
    expect(renderParsedClinicalResponse(severityQuestionPlan)).toContain('For nausea,');
  });
});

describe('EXPLAINERS map', () => {
  it('is closed over exactly the QUESTIONS/need fields', () => {
    expect(Object.keys(EXPLAINERS).sort()).toEqual([...needFieldSchema.options].sort());
  });

  it('keeps every explainer plain: non-empty, sentence-terminated, no emoji, no banned triage adjectives', () => {
    for (const explainer of Object.values(EXPLAINERS)) {
      expect(explainer.length).toBeGreaterThan(0);
      expect(explainer.endsWith('.')).toBe(true);
      expect(/\p{Extended_Pictographic}/u.test(explainer)).toBe(false);
      for (const term of BANNED_SEVERITY_TERMS) {
        expect(explainer.toLowerCase()).not.toContain(term);
      }
    }
  });

  it('pins the owner-provided severity explainer', () => {
    expect(EXPLAINERS.severity).toBe(
      '1 means you barely notice it, 10 is the worst you have ever felt.',
    );
  });
});

describe('Wave 1e — context-battery question bank', () => {
  const onsetQuestionPlan: ClinicalResponsePlan = {
    kind: 'question',
    question: {
      needId: 'need-onset',
      eventId: 'event-nausea',
      field: 'onset',
      questionId: 'question-onset',
      targetLabel: 'nausea',
    },
    reviewReasons: [],
  };

  it('pins the generic and labeled onset question text', () => {
    expect(renderParsedClinicalResponse(onsetQuestionPlan)).toBe(
      'I’ve noted your update. For nausea, when did this start?',
    );
  });

  it('renders every new context-battery field generically without a label', () => {
    for (const field of [
      'onset',
      'quality',
      'triggers',
      'associated_symptoms',
      'recurrence_history',
    ] as const) {
      const plan: ClinicalResponsePlan = {
        kind: 'question',
        question: {
          needId: `need-${field}`,
          eventId: 'event-nausea',
          field,
          questionId: `question-${field}`,
        },
        reviewReasons: [],
      };
      expect(renderParsedClinicalResponse(plan)).toContain('I’ve noted your update.');
    }
  });
});

describe('renderer version', () => {
  it('is bumped to renderer-v2 for the orientation + re-ask template additions', () => {
    expect(CLINICAL_RENDERER_VERSION).toBe('renderer-v2');
  });
});

describe('Lane Q — RE-ASK ROUTE pendingReask rendering (2026-08-17 live incident)', () => {
  const hugeLabel = 'x'.repeat(400);
  const promptedDosePlan: ClinicalResponsePlan = {
    kind: 'routine',
    pendingReask: { kind: 'prompted_dose', doseId: 'dose-1', medicationLabel: 'metformin' },
    reviewReasons: [],
  };

  it('renders the prompted-dose fallback standalone, replacing the routine orientation reply', () => {
    expect(renderClinicalResponse(promptedDosePlan)).toBe(
      'Just following up on my earlier question. Have you taken your metformin yet? ' +
        'A quick yes or no works, or tell me more.',
    );
  });

  it('degrades an oversize medication label to the generic label-free prompted-dose question', () => {
    const rendered = renderClinicalResponse({
      kind: 'routine',
      pendingReask: { kind: 'prompted_dose', doseId: 'dose-1', medicationLabel: hugeLabel },
      reviewReasons: [],
    });
    expect(rendered.length).toBeLessThanOrEqual(MAX_SMS_RESPONSE_CHARS);
    expect(rendered).toBe(
      'Just following up on my earlier question. Have you taken your dose yet? ' +
        'A quick yes or no works, or tell me more.',
    );
  });

  it('appends the prompted-dose restate to a human_review reply — the exact incident text', () => {
    expect(
      renderClinicalResponse({
        kind: 'human_review',
        pendingReask: { kind: 'prompted_dose', doseId: 'dose-1', medicationLabel: 'metformin' },
        reviewReasons: ['budget_exhausted'],
      }),
    ).toBe(
      'Thanks. I saved this update for your doctor to review. ' +
        'Just following up on my earlier question. Have you taken your metformin yet? ' +
        'A quick yes or no works, or tell me more.',
    );
  });

  it('appends an asked-need restate to a human_review reply, identical text to question.reask=true', () => {
    expect(
      renderClinicalResponse({
        kind: 'human_review',
        pendingReask: { kind: 'need', needId: 'need-1', field: 'severity', targetLabel: 'nausea' },
        reviewReasons: ['malformed_output'],
      }),
    ).toBe(
      'Thanks. I saved this update for your doctor to review. ' +
        'Just following up on my earlier question. For nausea, what number from 1 to 10 best ' +
        'describes the symptom’s intensity? 1 means you barely notice it, 10 is the worst you ' +
        'have ever felt.',
    );
  });

  it('degrades an oversize need label in a human_review append to the generic question, still appended', () => {
    const rendered = renderClinicalResponse({
      kind: 'human_review',
      pendingReask: { kind: 'need', needId: 'need-1', field: 'duration', targetLabel: hugeLabel },
      reviewReasons: ['malformed_output'],
    });
    expect(rendered.length).toBeLessThanOrEqual(MAX_SMS_RESPONSE_CHARS);
    expect(rendered.startsWith('Thanks. I saved this update for your doctor to review.')).toBe(
      true,
    );
    expect(rendered).toContain('How long has this been happening?');
    expect(rendered).not.toContain(hugeLabel);
  });

  it('leaves the plain human_review/important templates byte-identical when pendingReask is absent', () => {
    expect(renderClinicalResponse({ kind: 'human_review', reviewReasons: [] })).toBe(
      'Thanks. I saved this update for your doctor to review.',
    );
    expect(renderClinicalResponse({ kind: 'important', reviewReasons: [] })).toBe(
      'Thanks. I saved this update for your doctor to review.',
    );
  });

  describe('pendingReask schema scope', () => {
    it('rejects pendingReask together with question', () => {
      expect(() =>
        clinicalResponsePlanSchema.parse({
          kind: 'question',
          question: { needId: 'n', field: 'severity', questionId: 'q', targetLabel: 'x' },
          pendingReask: { kind: 'prompted_dose', doseId: 'dose-1', medicationLabel: 'metformin' },
          reviewReasons: [],
        }),
      ).toThrow();
    });

    it('rejects pendingReask on kinds other than human_review or routine', () => {
      for (const kind of [
        'important',
        'emergency',
        'stop',
        'unsupported_language',
        'stale_snapshot',
      ]) {
        expect(() =>
          clinicalResponsePlanSchema.parse({
            kind,
            pendingReask: { kind: 'prompted_dose', doseId: 'dose-1', medicationLabel: 'metformin' },
            reviewReasons: [],
          }),
        ).toThrow();
      }
    });

    it('rejects the need flavor of pendingReask on a routine plan (need flavor requires human_review)', () => {
      expect(() =>
        clinicalResponsePlanSchema.parse({
          kind: 'routine',
          pendingReask: {
            kind: 'need',
            needId: 'need-1',
            field: 'severity',
            targetLabel: 'nausea',
          },
          reviewReasons: [],
        }),
      ).toThrow();
    });

    it('accepts the prompted_dose flavor on routine and both flavors on human_review', () => {
      expect(() => clinicalResponsePlanSchema.parse(promptedDosePlan)).not.toThrow();
      expect(() =>
        clinicalResponsePlanSchema.parse({
          kind: 'human_review',
          pendingReask: {
            kind: 'need',
            needId: 'need-1',
            field: 'severity',
            targetLabel: 'nausea',
          },
          reviewReasons: [],
        }),
      ).not.toThrow();
      expect(() =>
        clinicalResponsePlanSchema.parse({
          kind: 'human_review',
          pendingReask: { kind: 'prompted_dose', doseId: 'dose-1', medicationLabel: 'metformin' },
          reviewReasons: [],
        }),
      ).not.toThrow();
    });
  });
});
