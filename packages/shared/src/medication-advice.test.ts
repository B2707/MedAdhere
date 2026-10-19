import { describe, expect, it } from 'vitest';
import { containsProhibitedMedicationAdvice } from './medication-advice.js';

describe('patient-facing medication advice boundary', () => {
  it.each([
    'Stop taking your medication.',
    'Augmentez votre dose.',
    'Deje de tomar su medicamento.',
    'أوقف الدواء',
  ])('blocks a direct medication-change instruction: %s', (text) => {
    expect(containsProhibitedMedicationAdvice(text)).toBe(true);
  });

  it.each([
    "I can't advise you to stop your medication.",
    'Do not change your dose.',
    'I noted that you stopped taking it yesterday.',
    'Thanks for the update. I saved it for your doctor.',
  ])('does not block a refusal, patient report, or neutral acknowledgement: %s', (text) => {
    expect(containsProhibitedMedicationAdvice(text)).toBe(false);
  });
});
