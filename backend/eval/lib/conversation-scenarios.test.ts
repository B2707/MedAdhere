/**
 * Phase 08-01 conversation-corpus gate.
 *
 * These tests freeze a reviewed behavior rubric, not fabricated model output. Provider failures
 * are observations produced by the runner and therefore never appear as gold expectations.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  CONVERSATION_DEV_PATH,
  CONVERSATION_HOLDOUT_PATH,
  CONVERSATION_MANIFEST_PATH,
  loadConversationScenarioCorpus,
  parseConversationScenarioDocument,
  sha256Hex,
  toConversationTurnExpectations,
} from './conversation-scenarios.js';

const REQUIRED_CATEGORIES = [
  'normal_check_in',
  'missing_information',
  'recurrence',
  'changing_symptoms',
  'paired_symptoms',
  'multiple_medications',
  'temporal_correction',
  'next_day_attribution',
  'am_pm_ambiguity',
  'multilingual',
  'uncovered_knowledge',
  'emergency',
  'stop',
  'spam',
  'jailbreak',
  'cross_doctor_access',
] as const;

const CRITICAL_HARD_GATES = [
  'emergency_safety',
  'stop_provider_app_state',
  'cross_doctor_isolation',
  'structured_output',
  'patient_claim_faithfulness',
  'evidence_template_integrity',
  'prohibited_medication_change',
  'critical_temporal',
  'one_call_next_turn_retrieval',
] as const;

describe('conversation scenario corpus — reviewed v12 dev plus locked v2 holdout', () => {
  const corpus = loadConversationScenarioCorpus();
  const all = [...corpus.dev.scenarios, ...corpus.holdout.scenarios];

  it('contains exactly 48 development and 24 locked-holdout alternating transcripts', () => {
    expect(corpus.dev.version).toBe('v12');
    expect(corpus.holdout.version).toBe('v2');
    expect(corpus.dev.scenarios).toHaveLength(48);
    expect(corpus.holdout.scenarios).toHaveLength(24);
    for (const scenario of all) {
      expect(scenario.transcript.length).toBeGreaterThanOrEqual(3);
      expect(scenario.transcript[0]?.role).toBe('patient');
      for (const [index, message] of scenario.transcript.entries()) {
        expect(message.role).toBe(index % 2 === 0 ? 'patient' : 'reference_agent');
      }
    }
  });

  it('counts at least 300 aggregate patient plus reference-agent transcript messages', () => {
    const transcriptMessages = all.reduce(
      (total, scenario) => total + scenario.transcript.length,
      0,
    );
    expect(transcriptMessages).toBeGreaterThanOrEqual(300);
  });

  it('gives every patient message an explicit scoreable rubric, not a fabricated output', () => {
    for (const scenario of all) {
      for (const [messageIndex, message] of scenario.transcript.entries()) {
        if (message.role !== 'patient') continue;
        expect(message.expectation.applicableMetrics.length).toBeGreaterThan(0);
        expect(message.expectation.requiredConcepts.length).toBeGreaterThan(0);
        expect(Array.isArray(message.expectation.expectedObservationKinds)).toBe(true);
        expect(Array.isArray(message.expectation.expectedTemporalCandidateIds)).toBe(true);
        const availablePatientMessageIds = scenario.transcript
          .slice(0, messageIndex + 1)
          .flatMap((item) => (item.role === 'patient' ? [item.id] : []));
        if (message.expectation.eligibleForProvider) {
          expect(message.expectation.expectedDraftSourceMessageIds).toContain(message.id);
          expect(
            message.expectation.expectedDraftSourceMessageIds.every((sourceMessageId) =>
              availablePatientMessageIds.includes(sourceMessageId),
            ),
          ).toBe(true);
        } else {
          expect(message.expectation.expectedDraftSourceMessageIds).toEqual([]);
        }
        if (message.expectation.eligibleForProvider) {
          expect(['acknowledge', 'ask_clarification', 'complete_turn']).toContain(
            message.expectation.expectedAction,
          );
          const clarification = message.expectation.clarificationRubric;
          expect(clarification).toBeDefined();
          if (clarification === undefined) continue;
          expect(clarification.required).toBe(
            message.expectation.expectedAction === 'ask_clarification',
          );
          expect(clarification.highestPriorityTopic === null).toBe(!clarification.required);
          if (clarification.required) {
            expect(message.expectation.applicableMetrics).toEqual(
              expect.arrayContaining([
                'useful_clarification_rate',
                'clarification_priority_rate',
                'single_question_rate',
                'clarification_non_repetition_rate',
              ]),
            );
            expect(message.expectation.applicableMetrics).not.toContain(
              'unnecessary_question_rate',
            );
          } else {
            expect(message.expectation.applicableMetrics).toContain('unnecessary_question_rate');
          }
        }
        expect(message.expectation).not.toHaveProperty('status');
        expect(message.expectation).not.toHaveProperty('output');
      }
    }
  });

  it('pins exact temporal candidates for critical holdout cases', () => {
    const nextDay = corpus.holdout.scenarios.filter((scenario) =>
      scenario.categories.includes('next_day_attribution'),
    );
    const ambiguous = corpus.holdout.scenarios.filter((scenario) =>
      scenario.categories.includes('am_pm_ambiguity'),
    );
    const corrections = corpus.holdout.scenarios.filter((scenario) =>
      scenario.categories.includes('temporal_correction'),
    );
    expect(nextDay.length).toBeGreaterThan(0);
    expect(ambiguous.length).toBeGreaterThan(0);
    expect(corrections.length).toBeGreaterThan(0);

    for (const scenario of nextDay) {
      const dates = scenario.scenarioContext.doseTimeFacts.map((dose) => dose.localDate).sort();
      const latestDate = dates.at(-1)!;
      const priorDayIds = scenario.scenarioContext.doseTimeFacts
        .filter((dose) => dose.localDate < latestDate)
        .map((dose) => dose.id);
      const todayIds = scenario.scenarioContext.doseTimeFacts
        .filter((dose) => dose.localDate === latestDate)
        .map((dose) => dose.id);
      expect(priorDayIds.length).toBeGreaterThan(0);
      for (const message of scenario.transcript) {
        if (message.role !== 'patient') continue;
        expect(message.expectation.expectedTemporalCandidateIds).toEqual(priorDayIds);
        expect(
          message.expectation.expectedTemporalCandidateIds.some((id) => todayIds.includes(id)),
        ).toBe(false);
      }
    }

    for (const scenario of ambiguous) {
      const allCandidates = scenario.scenarioContext.doseTimeFacts.map((dose) => dose.id);
      expect(allCandidates.length).toBeGreaterThanOrEqual(2);
      const patientTurns = scenario.transcript.filter((message) => message.role === 'patient');
      for (const message of patientTurns) {
        expect(message.expectation.expectedTemporalCandidateIds).toEqual(allCandidates);
      }
      expect(patientTurns[0]?.expectation.expectedAction).toBe('ask_clarification');
      for (const laterTurn of patientTurns.slice(1)) {
        expect(laterTurn.expectation.expectedAction).toBe('complete_turn');
      }
    }

    for (const scenario of corrections) {
      for (const message of scenario.transcript) {
        if (message.role !== 'patient') continue;
        expect(message.expectation.expectedTemporalCandidateIds.length).toBeGreaterThan(0);
      }
    }
  });

  it('uses one intent-specific question only when a clarification is still useful', () => {
    for (const scenario of all) {
      for (const [index, message] of scenario.transcript.entries()) {
        if (
          message.role !== 'patient' ||
          message.expectation.expectedAction !== 'ask_clarification'
        ) {
          continue;
        }
        expect(message.expectation.applicableMetrics).toContain('useful_clarification_rate');
        const reference = scenario.transcript[index + 1];
        expect(reference?.role).toBe('reference_agent');
        if (reference?.role === 'reference_agent') {
          expect(reference.text.match(/[?؟]/g)).toHaveLength(1);
          expect(reference.text.trim()).toMatch(/[?؟]$/u);
          expect(reference.text).not.toMatch(/[\r\n]/u);
          expect([...reference.text.trim()].length).toBeLessThanOrEqual(160);
        }
      }
    }

    const corrected = corpus.holdout.scenarios.find(
      (scenario) => scenario.id === 'conv-holdout-v2-004',
    )!;
    const firstPatient = corrected.transcript[0];
    const firstReference = corrected.transcript[1];
    expect(firstPatient?.role).toBe('patient');
    if (firstPatient?.role === 'patient') {
      expect(firstPatient.expectation.expectedAction).toBe('ask_clarification');
      expect(firstPatient.expectation.requiredConcepts).toContain(
        'preserve the already selected prior-day dose candidate',
      );
    }
    expect(firstReference).toEqual(
      expect.objectContaining({
        role: 'reference_agent',
        text: 'Got it — about what time after midnight?',
      }),
    );
  });

  it('pins taken when reported and unknown only after explicit adherence uncertainty', () => {
    const routine = corpus.dev.scenarios.find((scenario) => scenario.id === 'conv-dev-001')!;
    const missingTime = corpus.dev.scenarios.find((scenario) => scenario.id === 'conv-dev-004')!;
    const routinePatient = routine.transcript.find((message) => message.role === 'patient')!;
    const missingPatients = missingTime.transcript.filter((message) => message.role === 'patient');
    expect(routinePatient.expectation.expectedAdherenceClassification).toEqual({
      adherence_state: 'taken',
      reason_code: 'none',
      safety_flag: 'none',
    });
    expect(missingPatients[0]?.expectation.expectedAdherenceClassification).toEqual({
      adherence_state: 'taken',
      reason_code: 'none',
      safety_flag: 'none',
    });
    expect(missingPatients[1]?.expectation.expectedAdherenceClassification).toEqual({
      adherence_state: 'taken',
      reason_code: 'none',
      safety_flag: 'none',
    });
    expect(missingPatients[2]?.text).toContain('لست متأكدًا');
    expect(missingPatients[2]?.expectation.expectedAdherenceClassification).toEqual({
      adherence_state: 'unknown',
      reason_code: 'none',
      safety_flag: 'none',
    });
  });

  it('encodes the approved conversation behavior instead of the original placeholder rubric', () => {
    const patientTurns = (scenarioId: string) =>
      corpus.dev.scenarios
        .find((scenario) => scenario.id === scenarioId)!
        .transcript.filter((message) => message.role === 'patient');

    const routine = patientTurns('conv-dev-001');
    expect(routine.map((turn) => turn.expectation.expectedObservationKinds)).toEqual([
      ['medication_taking'],
      ['context'],
      ['context'],
    ]);
    expect(routine.map((turn) => turn.expectation.expectedAdherenceClassification)).toEqual([
      { adherence_state: 'taken', reason_code: 'none', safety_flag: 'none' },
      null,
      null,
    ]);
    // Superseded 2026-08-14: the redesigned deterministic core binds a dose only from an
    // explicitly named medication, so every English turn that used to carry a model-guessed
    // dose candidate now records none. See the per-turn rationale in the 08 recovery notes.
    expect(
      routine.every((turn) => turn.expectation.expectedTemporalCandidateIds.length === 0),
    ).toBe(true);
    for (const [scenarioId, turnIndex] of [
      ['conv-dev-002', 0],
      ['conv-dev-003', 0],
      ['conv-dev-016', 0],
      ['conv-dev-018', 1],
      ['conv-dev-029', 0],
      ['conv-dev-030', 0],
    ] as const) {
      expect(patientTurns(scenarioId)[turnIndex]?.expectation.clarificationRubric).toMatchObject({
        required: true,
        highestPriorityTopic: 'dose_time',
      });
    }
    // The English counterparts lost that question with the dose guess that motivated it.
    for (const [scenarioId, turnIndex] of [
      ['conv-dev-001', 0],
      ['conv-dev-017', 1],
      ['conv-dev-025', 0],
    ] as const) {
      expect(patientTurns(scenarioId)[turnIndex]?.expectation).toMatchObject({
        expectedAction: 'complete_turn',
        expectedTemporalCandidateIds: [],
        clarificationRubric: { required: false, highestPriorityTopic: null },
      });
    }

    for (const scenarioId of ['conv-dev-002', 'conv-dev-003']) {
      const finalTurn = patientTurns(scenarioId)[2]!;
      expect(finalTurn.expectation.expectedObservationKinds).toEqual(['context']);
      expect(finalTurn.expectation.expectedAdherenceClassification).toBeNull();
    }
    expect(patientTurns('conv-dev-005')[2]?.expectation.expectedObservationKinds).toEqual([
      'symptom',
      'correction',
    ]);

    expect(patientTurns('conv-dev-007').map((turn) => turn.expectation.expectedAction)).toEqual([
      'ask_clarification',
      'complete_turn',
      'complete_turn',
    ]);
    for (const scenarioId of ['conv-dev-007', 'conv-dev-008', 'conv-dev-009']) {
      expect(patientTurns(scenarioId)[2]?.expectation.expectedObservationKinds).toEqual([
        'severity',
      ]);
      expect(patientTurns(scenarioId)[2]?.expectation.expectedSeverity).toBe(2);
    }
    expect(patientTurns('conv-dev-010')[0]?.expectation.expectedObservationKinds).toEqual([
      'symptom',
      'severity',
    ]);
    expect(patientTurns('conv-dev-011')[0]?.expectation.expectedObservationKinds).toEqual([
      'symptom',
      'severity',
    ]);
    expect(patientTurns('conv-dev-012')[0]?.expectation.expectedObservationKinds).toEqual([
      'symptom',
      'duration',
    ]);
    expect(patientTurns('conv-dev-013')[0]?.expectation.expectedObservationKinds).toEqual([
      'symptom',
      'symptom',
    ]);
    expect(patientTurns('conv-dev-013').map((turn) => turn.expectation.expectedAction)).toEqual([
      'ask_clarification',
      'complete_turn',
      'ask_clarification',
    ]);
    for (const scenarioId of [
      'conv-dev-007',
      'conv-dev-008',
      'conv-dev-009',
      'conv-dev-013',
      'conv-dev-014',
      'conv-dev-015',
    ]) {
      const secondTurn = patientTurns(scenarioId)[1]!;
      expect(secondTurn.expectation.expectedAction).toBe('complete_turn');
      expect(secondTurn.expectation.applicableMetrics).not.toContain('useful_clarification_rate');
    }
    for (const scenarioId of ['conv-dev-013', 'conv-dev-014', 'conv-dev-015']) {
      for (const turn of patientTurns(scenarioId)) {
        expect(turn.expectation.expectedTemporalCandidateIds).toEqual([]);
      }
    }
    expect(patientTurns('conv-dev-022').map((turn) => turn.expectation.expectedAction)).toEqual([
      'ask_clarification',
      'complete_turn',
      'complete_turn',
    ]);
    expect(
      patientTurns('conv-dev-012')
        .slice(1)
        .map((turn) => turn.expectation.expectedAction),
    ).toEqual(['ask_clarification', 'complete_turn']);
    expect(patientTurns('conv-dev-012')[1]?.expectation.clarificationRubric).toMatchObject({
      required: true,
      highestPriorityTopic: 'duration',
    });
    for (const turn of patientTurns('conv-dev-015').slice(1)) {
      expect(turn.expectation.expectedAction).toBe('complete_turn');
      expect(turn.expectation.applicableMetrics).not.toContain('useful_clarification_rate');
    }
    expect(
      patientTurns('conv-dev-019').map((turn) => turn.expectation.expectedObservationKinds),
    ).toEqual([['medication_taking', 'correction'], ['medication_taking'], ['context']]);
    expect(
      patientTurns('conv-dev-020').map((turn) => turn.expectation.expectedObservationKinds),
    ).toEqual([['medication_taking', 'correction'], ['correction'], ['medication_taking']]);
    expect(patientTurns('conv-dev-021').map((turn) => turn.expectation.expectedAction)).toEqual([
      'ask_clarification',
      'complete_turn',
      'ask_clarification',
    ]);
    expect(patientTurns('conv-dev-021')[2]?.expectation.expectedObservationKinds).toEqual([
      'symptom',
      'correction',
      'duration',
    ]);
    for (const scenarioId of ['conv-dev-022', 'conv-dev-023', 'conv-dev-024']) {
      expect(patientTurns(scenarioId)[2]?.expectation.expectedAction).toBe('complete_turn');
    }
    expect(
      patientTurns('conv-dev-029')
        .slice(1)
        .map((turn) => turn.expectation.expectedObservationKinds),
    ).toEqual([['context'], ['context']]);
    expect(patientTurns('conv-dev-030')[0]?.expectation.requiredConcepts).toContain(
      'resolve the mixed French-Spanish phrase as yesterday evening',
    );
    expect(
      patientTurns('conv-dev-033').every(
        (turn) => turn.expectation.expectedSafetyTier === 'important',
      ),
    ).toBe(true);
    expect(patientTurns('conv-dev-028').map((turn) => turn.expectation.expectedAction)).toEqual([
      'ask_clarification',
      'ask_clarification',
      'complete_turn',
    ]);

    for (const scenarioId of [
      'conv-dev-043',
      'conv-dev-044',
      'conv-dev-045',
      'conv-dev-046',
      'conv-dev-047',
      'conv-dev-048',
    ]) {
      for (const turn of patientTurns(scenarioId)) {
        expect(turn.expectation.expectedAction).toBe('acknowledge');
        expect(turn.expectation.expectedSafetyTier).toBe('none');
      }
    }
  });

  it('pins mixed-language and translation uncertainty per patient turn', () => {
    const mixedTurns = all.flatMap((scenario) =>
      scenario.transcript.filter(
        (message) => message.role === 'patient' && message.expectation.expectedMixedLanguage,
      ),
    );
    expect(mixedTurns.length).toBeGreaterThanOrEqual(4);
    expect(
      mixedTurns.some(
        (message) => message.role === 'patient' && message.expectation.expectedTranslationUncertain,
      ),
    ).toBe(true);
  });

  it('provides bounded synthetic context for history, medications, timing, and evidence', () => {
    expect(all.some((scenario) => scenario.scenarioContext.activeMedications.length > 1)).toBe(
      true,
    );
    expect(all.some((scenario) => scenario.scenarioContext.recentObservations.length > 0)).toBe(
      true,
    );
    expect(all.some((scenario) => scenario.scenarioContext.clinicalFacts.length > 0)).toBe(true);
    expect(all.some((scenario) => scenario.scenarioContext.doseTimeFacts.length > 1)).toBe(true);
    expect(all.some((scenario) => scenario.scenarioContext.evidence.length > 0)).toBe(true);
    for (const scenario of all) {
      if (
        scenario.categories.includes('recurrence') ||
        scenario.categories.includes('changing_symptoms')
      ) {
        expect(scenario.scenarioContext.recentObservations.length).toBeGreaterThan(0);
      }
      if (scenario.categories.includes('multiple_medications')) {
        expect(scenario.scenarioContext.activeMedications.length).toBeGreaterThanOrEqual(2);
        expect(scenario.scenarioContext.doseTimeFacts.length).toBeGreaterThanOrEqual(2);
      }
      if (scenario.hardGates.includes('critical_temporal')) {
        expect(scenario.scenarioContext.doseTimeFacts.length).toBeGreaterThanOrEqual(2);
      }
      if (scenario.hardGates.includes('patient_claim_faithfulness')) {
        expect(scenario.scenarioContext.clinicalFacts.length).toBeGreaterThan(0);
      }
    }
  });

  it('adapts every patient rubric directly into the metrics denominator contract', () => {
    const expectedTurns = toConversationTurnExpectations(corpus);
    const patientCount = all.reduce(
      (total, scenario) =>
        total + scenario.transcript.filter((message) => message.role === 'patient').length,
      0,
    );
    expect(expectedTurns).toHaveLength(patientCount);
    expect(expectedTurns.every((turn) => turn.applicableMetrics.length > 0)).toBe(true);
    expect(new Set(expectedTurns.map((turn) => `${turn.scenarioId}:${turn.turnId}`)).size).toBe(
      patientCount,
    );
  });

  it('uses UUIDs for every model-referenceable message and context record', () => {
    const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    for (const scenario of all) {
      for (const message of scenario.transcript) expect(message.id).toMatch(uuid);
      for (const medication of scenario.scenarioContext.activeMedications) {
        expect(medication.id).toMatch(uuid);
      }
      for (const fact of scenario.scenarioContext.clinicalFacts) expect(fact.id).toMatch(uuid);
      for (const observation of scenario.scenarioContext.recentObservations) {
        expect(observation.id).toMatch(uuid);
      }
      for (const dose of scenario.scenarioContext.doseTimeFacts) {
        expect(dose.id).toMatch(uuid);
        expect(dose.medicationId).toMatch(uuid);
      }
    }
  });

  it('uses globally unique scenario ids and scenario-local unique message ids', () => {
    const scenarioIds = all.map((scenario) => scenario.id);
    expect(new Set(scenarioIds).size).toBe(scenarioIds.length);
    for (const scenario of all) {
      const messageIds = scenario.transcript.map((message) => message.id);
      expect(new Set(messageIds).size).toBe(messageIds.length);
    }
  });

  it('covers every EVAL2-01 category', () => {
    const covered = new Set(all.flatMap((scenario) => scenario.categories));
    for (const category of REQUIRED_CATEGORIES) expect(covered.has(category)).toBe(true);
  });

  it('locks every critical hard-gate class into the holdout', () => {
    const covered = new Set(corpus.holdout.scenarios.flatMap((scenario) => scenario.hardGates));
    for (const hardGate of CRITICAL_HARD_GATES) expect(covered.has(hardGate)).toBe(true);
  });

  it('has at least four holdout scenarios per language and explicit mixed-language cases', () => {
    for (const language of ['en', 'fr', 'es', 'ar'] as const) {
      expect(
        corpus.holdout.scenarios.filter((scenario) => scenario.primaryLanguage === language).length,
      ).toBeGreaterThanOrEqual(4);
    }
    const mixed = corpus.holdout.scenarios.filter(
      (scenario) => scenario.additionalLanguages.length > 0,
    );
    expect(mixed.length).toBeGreaterThanOrEqual(4);
    expect(mixed.every((scenario) => scenario.categories.includes('multilingual'))).toBe(true);
  });

  it('makes emergency turns deterministic, emergency-tier, and question-free', () => {
    const emergencyScenarios = all.filter((scenario) => scenario.categories.includes('emergency'));
    expect(emergencyScenarios.length).toBeGreaterThan(0);
    for (const scenario of emergencyScenarios) {
      for (const message of scenario.transcript) {
        if (message.role === 'reference_agent') {
          expect(message.text).not.toContain('?');
          continue;
        }
        expect(message.expectation).toEqual(
          expect.objectContaining({
            eligibleForProvider: false,
            expectedAction: 'fixed_emergency',
            expectedSafetyTier: 'emergency',
            expectedEvidenceId: null,
            expectedTemplateId: null,
          }),
        );
        expect(message.expectation.forbiddenActions).toContain('ask_clarification');
      }
    }
  });

  it('makes STOP/provider-state turns deterministic and ineligible for the model provider', () => {
    const stopScenarios = all.filter((scenario) => scenario.categories.includes('stop'));
    expect(stopScenarios.length).toBeGreaterThan(0);
    for (const scenario of stopScenarios) {
      for (const message of scenario.transcript) {
        if (message.role !== 'patient') continue;
        expect(message.expectation.eligibleForProvider).toBe(false);
        expect(['fixed_stop', 'fixed_opted_out', 'fixed_start']).toContain(
          message.expectation.expectedAction,
        );
        expect(message.expectation.applicableMetrics).toContain('stop_state_correctness');
      }
    }
  });

  it('pins a normalize/clarify then deterministic-evidence fixture in dev and holdout', () => {
    for (const scenarios of [corpus.dev.scenarios, corpus.holdout.scenarios]) {
      const fixtures = scenarios.filter((scenario) =>
        scenario.hardGates.includes('one_call_next_turn_retrieval'),
      );
      expect(fixtures.length).toBeGreaterThan(0);
      for (const fixture of fixtures) {
        const patientTurns = fixture.transcript.filter((message) => message.role === 'patient');
        expect(patientTurns[0]?.expectation).toEqual(
          expect.objectContaining({
            expectedAction: 'ask_clarification',
            availableEvidenceIds: [],
            expectedEvidenceId: null,
            expectedTemplateId: null,
          }),
        );
        expect(patientTurns[0]?.expectation.retrievalSlices).toContain('one_call_first_turn');
        expect(patientTurns[1]?.expectation).toEqual(
          expect.objectContaining({
            availableEvidenceIds: ['medlineplus-dizziness-v1'],
            expectedEvidenceId: 'medlineplus-dizziness-v1',
            expectedTemplateId: 'patient-symptom-dizziness-v1',
          }),
        );
        expect(patientTurns[1]?.expectation.retrievalSlices).toContain('one_call_next_turn');
        expect(patientTurns[1]?.expectation.applicableMetrics).toContain(
          'one_call_next_turn_retrieval',
        );
      }
    }
  });

  it('keeps both original and correcting message provenance for current-day corrections', () => {
    const scenario = corpus.dev.scenarios.find(({ id }) => id === 'conv-dev-004')!;
    const patientTurns = scenario.transcript.filter(
      (message): message is Extract<(typeof scenario.transcript)[number], { role: 'patient' }> =>
        message.role === 'patient',
    );

    expect(patientTurns[2]?.expectation.expectedDraftSourceMessageIds).toEqual([
      patientTurns[0]?.id,
      patientTurns[2]?.id,
    ]);
  });

  it('does not attach changing symptoms to an unrelated same-day scheduled dose', () => {
    for (const scenarioId of ['conv-dev-010', 'conv-dev-011', 'conv-dev-012']) {
      const scenario = corpus.dev.scenarios.find(({ id }) => id === scenarioId)!;
      const patientTurns = scenario.transcript.filter(({ role }) => role === 'patient');

      expect(patientTurns).toHaveLength(3);
      for (const turn of patientTurns) {
        if (turn.role !== 'patient') continue;
        expect(turn.expectation.expectedTemporalCandidateIds).toEqual([]);
      }
    }
  });

  it('preserves both the original vague report and its later symptom clarification', () => {
    const scenario = corpus.dev.scenarios.find(({ id }) => id === 'conv-dev-021')!;
    const vagueReport = scenario.transcript.find(
      ({ id }) => id === 'b919f32f-1462-4f12-bbf7-27236bed642b',
    );
    const clarification = scenario.transcript.find(
      ({ id }) => id === 'af479246-3ec8-4e94-9ef5-c3651425da2d',
    );

    expect(vagueReport?.role).toBe('patient');
    if (vagueReport?.role !== 'patient') throw new Error('vague report turn missing');
    expect(vagueReport.expectation.expectedTemporalCandidateIds).toEqual([]);
    expect(vagueReport.expectation.applicableMetrics).not.toContain(
      'critical_temporal_correctness',
    );
    expect(clarification?.role).toBe('patient');
    if (clarification?.role !== 'patient') throw new Error('clarification turn missing');
    expect(clarification.expectation.expectedDraftSourceMessageIds).toEqual([
      'b919f32f-1462-4f12-bbf7-27236bed642b',
      'af479246-3ec8-4e94-9ef5-c3651425da2d',
    ]);
  });

  it('locks reviewed v2 files while preserving the failed v1 byte streams', () => {
    const manifestRaw = readFileSync(CONVERSATION_MANIFEST_PATH, 'utf8');
    const manifest = JSON.parse(manifestRaw) as {
      devSha256: string;
      devVersion: string;
      devFile: string;
      holdoutSha256: string;
      holdoutVersion: string;
      holdoutFile: string;
    };
    expect(manifest.devVersion).toBe('v12');
    expect(corpus.manifest.evalSetVersion).toBe('v2');
    expect(manifest.devFile).toBe('dev.v12.json');
    expect(manifest.holdoutVersion).toBe('v2');
    expect(manifest.holdoutFile).toBe('holdout.v2.json');
    expect(manifest.devSha256).toBe(
      'afdfbff857e8452e0c80f65a9c73fa936579cf43777d292027f5309848be798a',
    );
    expect(manifest.holdoutSha256).toBe(
      '9dd1c73e17d1592f4ddb2fbf2de29053829f34cf3dc9112700da541a5484d37c',
    );
    expect(sha256Hex(readFileSync(CONVERSATION_DEV_PATH))).toBe(manifest.devSha256);
    expect(sha256Hex(readFileSync(CONVERSATION_HOLDOUT_PATH))).toBe(manifest.holdoutSha256);
    expect(corpus.manifest).toEqual(expect.objectContaining(manifest));

    expect(sha256Hex(readFileSync(new URL('../conversation/dev.v7.json', import.meta.url)))).toBe(
      '3aeab7fb6fddbc2fa9617a63ecb6dd128d5fdf3e3c4f22b119fab414c07e7c00',
    );
    expect(sha256Hex(readFileSync(new URL('../conversation/dev.v8.json', import.meta.url)))).toBe(
      '8cf7d192a271a3b728dda37e1727f5a39e1cf8a736b8b43b386e62a7c328d42e',
    );

    expect(sha256Hex(readFileSync(new URL('../conversation/dev.v6.json', import.meta.url)))).toBe(
      '5f6302dc9469e016d98513040c5490a79415bd0c62e3e4ec9008ba57e2561237',
    );
    expect(
      sha256Hex(readFileSync(new URL('../conversation/holdout.v1.json', import.meta.url))),
    ).toBe('cb64a35f6fe0a869227ccb5f5fa17aac62254472f7b039e2bdb3e12f96e1eff6');
    const priorManifest = JSON.parse(
      readFileSync(new URL('../conversation/manifest.v1.json', import.meta.url), 'utf8'),
    ) as { devSha256: string; holdoutSha256: string };
    expect(priorManifest).toEqual(
      expect.objectContaining({
        devSha256: '5f6302dc9469e016d98513040c5490a79415bd0c62e3e4ec9008ba57e2561237',
        holdoutSha256: 'cb64a35f6fe0a869227ccb5f5fa17aac62254472f7b039e2bdb3e12f96e1eff6',
      }),
    );
  });

  it('corrects the seven disputed v1 question labels with explicit v2 priorities', () => {
    const corrected = new Map([
      ['50325d38-b309-4ce5-b303-2307bb2c99c2', 'severity'],
      ['4049c635-fcf0-48ef-b081-74f373bb66fc', 'severity'],
      ['16cdc496-072d-48da-a840-3e65a52cc385', 'interaction_item_identity'],
      ['90bd6e05-1aa9-407b-95ab-bc75edc27552', 'recurrence_comparison'],
      ['eee68d98-6301-45fd-bc30-b12c607431ba', 'recurrence_comparison'],
      ['abba5237-1b50-491f-8ac3-797043147016', 'medication_taking'],
      ['3727e3e8-f3e5-4a8a-8dae-7f56c19fb216', 'medication_identity'],
    ] as const);
    const turns = corpus.holdout.scenarios.flatMap((scenario) =>
      scenario.transcript.filter((message) => message.role === 'patient'),
    );

    for (const [turnId, highestPriorityTopic] of corrected) {
      const turn = turns.find(({ id }) => id === turnId);
      expect(turn?.expectation).toEqual(
        expect.objectContaining({
          expectedAction: 'ask_clarification',
          clarificationRubric: {
            required: true,
            highestPriorityTopic,
            previouslyAnsweredTopics: expect.any(Array),
          },
        }),
      );
    }
  });
});

describe('conversation scenario corpus — strict failure behavior', () => {
  it('allows repeated observation kinds so paired symptoms can be scored separately', () => {
    const document = JSON.parse(readFileSync(CONVERSATION_DEV_PATH, 'utf8')) as {
      scenarios: Array<{
        transcript: Array<{
          role: string;
          expectation?: { expectedObservationKinds: string[] };
        }>;
      }>;
    };
    const patient = document.scenarios[0]!.transcript.find(
      (message) => message.role === 'patient',
    )!;
    patient.expectation!.expectedObservationKinds = ['symptom', 'symptom'];

    expect(() => parseConversationScenarioDocument(JSON.stringify(document), 'dev')).not.toThrow();
  });

  it('rejects an unknown rubric key', () => {
    const document = JSON.parse(readFileSync(CONVERSATION_DEV_PATH, 'utf8')) as {
      scenarios: Array<{
        transcript: Array<{ role: string; expectation?: Record<string, unknown> }>;
      }>;
    };
    const patient = document.scenarios[0]!.transcript.find((message) => message.role === 'patient');
    patient!.expectation!.unexpected = true;
    expect(() => parseConversationScenarioDocument(JSON.stringify(document), 'dev')).toThrow(
      /unrecognized|unknown/i,
    );
  });

  it('rejects clarification rubrics and metric denominators that disagree with the action', () => {
    const document = JSON.parse(readFileSync(CONVERSATION_DEV_PATH, 'utf8')) as {
      scenarios: Array<{
        transcript: Array<{
          role: string;
          expectation?: {
            expectedAction: string;
            applicableMetrics: string[];
          };
        }>;
      }>;
    };
    const required = document.scenarios
      .flatMap(({ transcript }) => transcript)
      .find((message) => message.expectation?.expectedAction === 'ask_clarification')!;
    required.expectation!.expectedAction = 'complete_turn';
    expect(() => parseConversationScenarioDocument(JSON.stringify(document), 'dev')).toThrow(
      /clarification rubric/iu,
    );

    required.expectation!.expectedAction = 'ask_clarification';
    required.expectation!.applicableMetrics.push('unnecessary_question_rate');
    expect(() => parseConversationScenarioDocument(JSON.stringify(document), 'dev')).toThrow(
      /clarification metrics/iu,
    );
  });

  it('rejects duplicate message ids within a scenario', () => {
    const document = JSON.parse(readFileSync(CONVERSATION_DEV_PATH, 'utf8')) as {
      scenarios: Array<{ transcript: Array<{ id: string }> }>;
    };
    document.scenarios[0]!.transcript[1]!.id = document.scenarios[0]!.transcript[0]!.id;
    expect(() => parseConversationScenarioDocument(JSON.stringify(document), 'dev')).toThrow(
      /duplicate message id/i,
    );
  });

  it('rejects deterministic paths that demand provider output or a provider-authored draft', () => {
    const document = JSON.parse(readFileSync(CONVERSATION_DEV_PATH, 'utf8')) as {
      scenarios: Array<{
        categories: string[];
        transcript: Array<{
          id: string;
          role: string;
          expectation?: {
            requiredStructuredFields: string[];
            expectedDraftSourceMessageIds: string[];
          };
        }>;
      }>;
    };
    const scenario = document.scenarios.find((item) => item.categories.includes('emergency'))!;
    const patient = scenario.transcript.find((message) => message.role === 'patient')!;
    patient.expectation!.requiredStructuredFields = ['action'];
    patient.expectation!.expectedDraftSourceMessageIds = [patient.id];
    expect(() => parseConversationScenarioDocument(JSON.stringify(document), 'dev')).toThrow(
      /deterministic paths/i,
    );
  });

  it('rejects a dose fact that references a medication outside scenario context', () => {
    const document = JSON.parse(readFileSync(CONVERSATION_DEV_PATH, 'utf8')) as {
      scenarios: Array<{
        scenarioContext: { doseTimeFacts: Array<{ medicationId: string }> };
      }>;
    };
    document.scenarios[0]!.scenarioContext.doseTimeFacts[0]!.medicationId =
      '00000000-0000-4000-8000-000000000099';
    expect(() => parseConversationScenarioDocument(JSON.stringify(document), 'dev')).toThrow(
      /dose medication/i,
    );
  });

  it('rejects an expected temporal candidate absent from scenario context', () => {
    const document = JSON.parse(readFileSync(CONVERSATION_DEV_PATH, 'utf8')) as {
      scenarios: Array<{
        transcript: Array<{
          role: string;
          expectation?: { expectedTemporalCandidateIds: string[] };
        }>;
      }>;
    };
    const patient = document.scenarios[0]!.transcript.find(
      (message) => message.role === 'patient',
    )!;
    patient.expectation!.expectedTemporalCandidateIds = ['00000000-0000-4000-8000-000000000099'];
    expect(() => parseConversationScenarioDocument(JSON.stringify(document), 'dev')).toThrow(
      /temporal candidate.*absent/i,
    );
  });

  it('rejects a provider-eligible turn that omits its source patient message', () => {
    const document = JSON.parse(readFileSync(CONVERSATION_DEV_PATH, 'utf8')) as {
      scenarios: Array<{
        transcript: Array<{
          role: string;
          expectation?: { expectedDraftSourceMessageIds: string[] };
        }>;
      }>;
    };
    const patient = document.scenarios[0]!.transcript.find(
      (message) => message.role === 'patient',
    )!;
    patient.expectation!.expectedDraftSourceMessageIds = [];
    expect(() => parseConversationScenarioDocument(JSON.stringify(document), 'dev')).toThrow(
      /explicitly source/i,
    );
  });

  it('rejects turn evidence that is unavailable or absent from scenario context', () => {
    const document = JSON.parse(readFileSync(CONVERSATION_DEV_PATH, 'utf8')) as {
      scenarios: Array<{
        hardGates: string[];
        transcript: Array<{
          role: string;
          expectation?: {
            availableEvidenceIds: string[];
            expectedEvidenceId: string | null;
          };
        }>;
      }>;
    };
    const fixture = document.scenarios.find((scenario) =>
      scenario.hardGates.includes('one_call_next_turn_retrieval'),
    )!;
    const patientTurns = fixture.transcript.filter((message) => message.role === 'patient');
    patientTurns[0]!.expectation!.availableEvidenceIds = ['evidence-not-in-context'];
    patientTurns[1]!.expectation!.availableEvidenceIds = [];
    expect(() => parseConversationScenarioDocument(JSON.stringify(document), 'dev')).toThrow(
      /absent from scenario context|must be available/i,
    );
  });

  it('rejects a template that is not allowed by the expected evidence', () => {
    const document = JSON.parse(readFileSync(CONVERSATION_DEV_PATH, 'utf8')) as {
      scenarios: Array<{
        hardGates: string[];
        transcript: Array<{
          role: string;
          expectation?: { expectedTemplateId: string | null };
        }>;
      }>;
    };
    const fixture = document.scenarios.find((scenario) =>
      scenario.hardGates.includes('one_call_next_turn_retrieval'),
    )!;
    const patientTurns = fixture.transcript.filter((message) => message.role === 'patient');
    patientTurns[1]!.expectation!.expectedTemplateId = 'template-not-allowed';
    expect(() => parseConversationScenarioDocument(JSON.stringify(document), 'dev')).toThrow(
      /template is not allowed/i,
    );
  });

  it('rejects a transcript that does not alternate roles', () => {
    const document = JSON.parse(readFileSync(CONVERSATION_DEV_PATH, 'utf8')) as {
      scenarios: Array<{ transcript: Array<Record<string, unknown>> }>;
    };
    const first = document.scenarios[0]!.transcript[0]!;
    document.scenarios[0]!.transcript[0] = document.scenarios[0]!.transcript[1]!;
    document.scenarios[0]!.transcript[1] = first;
    expect(() => parseConversationScenarioDocument(JSON.stringify(document), 'dev')).toThrow(
      /alternate/i,
    );
  });

  it('rejects invalid JSON and a partition mismatch', () => {
    expect(() => parseConversationScenarioDocument('{', 'dev')).toThrow(/invalid JSON/i);
    expect(() =>
      parseConversationScenarioDocument(readFileSync(CONVERSATION_DEV_PATH, 'utf8'), 'holdout'),
    ).toThrow(/partition/i);
  });
});
