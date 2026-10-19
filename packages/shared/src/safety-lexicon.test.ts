/**
 * safety-lexicon.test.ts — the SC3/SC7/SAFETY-04 shared safety contract (04-01, Phase 4).
 *
 * Pure unit tests (no DB, no AWS): the lexicon, the STOP/HELP keyword helpers, the two
 * auto-reply templates, and the prefilter's defensive bounds. The tagged term list is the
 * mechanical link to the gold set — every lexicon-matchable gold item carries one of these
 * tags, which is what makes prefilter-recall = 1.0 on that slice checkable offline (SC6).
 *
 * Regex-vs-LLM boundary (regex-vs-llm-structured-text, applied 2026-07-03): the regex
 * lexicon owns the DETERMINISTIC slice (explicit acute-physical / crisis phrasings); the
 * semantic remainder is the model's job (safety_flag). Patterns are fixed-word alternations
 * with \s+ separators and \b boundaries — no nested quantifiers, no unbounded wildcards —
 * so matching is linear-time (catastrophic-backtracking review, ULTRA LOW batch).
 */
import { describe, expect, it } from 'vitest';
import {
  BANNED_SEVERITY_TERMS,
  HELP_AUTO_REPLY,
  HELP_KEYWORDS,
  INTAKE_LIMIT_NOTICE,
  MEDIA_UNSUPPORTED_REPLY,
  PREFILTER_MAX_CHARS,
  SAFETY_AUTO_REPLY_EMERGENCY,
  SAFETY_AUTO_REPLY_MEDICAL_QUESTION,
  SAFETY_LEXICON,
  START_KEYWORDS,
  STOP_KEYWORDS,
  isHelpKeyword,
  isStartKeyword,
  isStopKeyword,
  safetyAutoReplyEmergency,
  runSafetyPrefilter,
} from './safety-lexicon.js';

describe('STOP/HELP keyword helpers (SC7 amendment: exact standalone keyword after trim/case-fold)', () => {
  it('recognizes every Twilio-standard STOP keyword, case-insensitively, with surrounding whitespace', () => {
    for (const kw of [
      'STOP',
      'stop',
      'Stop',
      ' stop ',
      '\tSTOPALL\n',
      'unsubscribe',
      'CANCEL',
      'End',
      'quit',
    ]) {
      expect(isStopKeyword(kw), `'${kw}' must deactivate`).toBe(true);
    }
  });

  it('does NOT treat embedded or prefixed mentions as STOP (exact standalone only)', () => {
    for (const body of [
      'please stop texting me at dinner',
      'stop it',
      'nonstop',
      'I want to stop taking it',
      'stopped',
    ]) {
      expect(isStopKeyword(body), `'${body}' must NOT deactivate`).toBe(false);
    }
  });

  it('recognizes HELP keywords exactly, and not embedded mentions', () => {
    expect(isHelpKeyword('HELP')).toBe(true);
    expect(isHelpKeyword(' help ')).toBe(true);
    expect(isHelpKeyword('info')).toBe(true);
    expect(isHelpKeyword('help me please')).toBe(false);
    expect(isHelpKeyword('helpful')).toBe(false);
  });

  it('recognizes START keywords exactly, and not embedded medication mentions', () => {
    expect(isStartKeyword('START')).toBe(true);
    expect(isStartKeyword(' start ')).toBe(true);
    expect(isStartKeyword('unstop')).toBe(true);
    expect(isStartKeyword('start my medication')).toBe(false);
    expect(isStartKeyword('restart')).toBe(false);
  });

  it('exports the keyword lists for the inbound handler + eval harness', () => {
    expect(STOP_KEYWORDS).toContain('stop');
    expect(START_KEYWORDS).toContain('start');
    expect(HELP_KEYWORDS).toContain('help');
  });
});

describe('safety prefilter (SC3 — the divert path that must never depend on the LLM)', () => {
  it('flags explicit crisis language as crisis', () => {
    for (const body of [
      'I want to kill myself',
      'feeling suicidal today',
      'i want to end my life',
      'better off dead',
    ]) {
      const r = runSafetyPrefilter(body);
      expect(r.hit, `'${body}' must hit`).toBe(true);
      expect(r.category).toBe('crisis');
    }
  });

  it('flags explicit acute-physical language as acute_physical', () => {
    for (const body of [
      'having chest pain since this morning',
      "took it but now I can't breathe",
      'I think I took too many pills',
      'my throat is swelling up',
      'I passed out after the dose',
    ]) {
      const r = runSafetyPrefilter(body);
      expect(r.hit, `'${body}' must hit`).toBe(true);
      expect(r.category).toBe('acute_physical');
    }
  });

  it.each([
    ['fr', 'J’ai une douleur à la poitrine', 'acute_physical'],
    ['fr', 'Je ne peux pas respirer', 'acute_physical'],
    ['fr', 'Je veux me suicider', 'crisis'],
    ['es', 'Tengo dolor en el pecho', 'acute_physical'],
    ['es', 'No puedo respirar', 'acute_physical'],
    ['es', 'Quiero suicidarme', 'crisis'],
    ['ar', 'لدي ألم في الصدر', 'acute_physical'],
    ['ar', 'لا أستطيع التنفس', 'acute_physical'],
    ['ar', 'أريد الانتحار', 'crisis'],
  ] as const)(
    'flags clear %s emergency wording and attributes its language: %s',
    (language, body, category) => {
      expect(runSafetyPrefilter(body)).toMatchObject({ hit: true, category, language });
    },
  );

  it.each([
    ['fr', 'Je veux mourir', 'crisis'],
    ['fr', 'Je veux me faire du mal', 'crisis'],
    ['fr', 'J’ai pris une surdose', 'acute_physical'],
    ['es', 'Quiero morir', 'crisis'],
    ['es', 'Quiero hacerme daño', 'crisis'],
    ['es', 'Tengo una sobredosis', 'acute_physical'],
    ['ar', 'أريد أن أموت', 'crisis'],
    ['ar', 'أريد إيذاء نفسي', 'crisis'],
    ['ar', 'أخذت جرعة زائدة', 'acute_physical'],
  ] as const)(
    'flags explicit localized crisis and overdose wording in %s: %s',
    (language, body, category) => {
      expect(runSafetyPrefilter(body)).toMatchObject({ hit: true, category, language });
    },
  );

  it.each([
    ['fr', 'Je n’arrive pas à respirer', 'acute_physical'],
    ['ar', 'لا استطيع التنفس', 'acute_physical'],
    ['fr', 'Je pense au suicide', 'crisis'],
  ] as const)(
    'recognizes common localized emergency spelling in %s: %s',
    (language, body, category) => {
      expect(runSafetyPrefilter(body)).toMatchObject({ hit: true, category, language });
    },
  );

  it('uses the expected-language hint for an otherwise language-ambiguous emergency term', () => {
    expect(runSafetyPrefilter('suicide', 'fr-CA')).toMatchObject({
      hit: true,
      category: 'crisis',
      language: 'fr',
    });
  });

  it('crisis takes precedence when both categories match', () => {
    const r = runSafetyPrefilter('chest pain and I want to end my life');
    expect(r.hit).toBe(true);
    expect(r.category).toBe('crisis');
  });

  it('does NOT flag benign adherence replies (side-effect mentions are the MODEL boundary, not the lexicon)', () => {
    for (const body of [
      'took it',
      'all good, no issues',
      'took half cuz my stomach hurt', // canonical partial+side_effect exemplar — semantic, NOT lexicon
      'forgot this morning, will take tonight',
      'feeling a bit dizzy', // mild side effect — model territory (regex-vs-llm boundary)
    ]) {
      expect(runSafetyPrefilter(body).hit, `'${body}' must NOT hit`).toBe(false);
    }
  });

  it('every lexicon term is self-consistent: unique tag, valid category, and its example matches its own pattern', () => {
    expect(SAFETY_LEXICON.length).toBeGreaterThanOrEqual(12);
    // Healthcare-review MEDIUM fixes (2026-07-03): literal, SMS-common acute phrasings the
    // deterministic slice must own (these are exactly the terms lost during an LLM outage).
    expect(runSafetyPrefilter("I think I'm having a heart attack").matchedTags).toContain(
      'heart_attack',
    );
    expect(runSafetyPrefilter('I keep passing out after the dose').matchedTags).toContain(
      'fainted',
    );
    expect(runSafetyPrefilter('he passes out every time').matchedTags).toContain('fainted');
    const tags = SAFETY_LEXICON.map((t) => t.tag);
    expect(new Set(tags).size, 'tags must be unique (they drive gold-set slice tagging)').toBe(
      tags.length,
    );
    for (const term of SAFETY_LEXICON) {
      expect(['acute_physical', 'crisis']).toContain(term.category);
      const r = runSafetyPrefilter(term.example);
      expect(r.hit, `example for tag '${term.tag}' must match the lexicon`).toBe(true);
      expect(r.matchedTags, `tag '${term.tag}' must attribute its own example`).toContain(term.tag);
    }
  });

  it(`bounds its input to PREFILTER_MAX_CHARS (${2000}) — a hit buried past the bound is not matched`, () => {
    expect(PREFILTER_MAX_CHARS).toBe(2000);
    const padding = 'took my meds this morning and all is well. '.repeat(60); // > 2,000 chars
    expect(padding.length).toBeGreaterThan(PREFILTER_MAX_CHARS);
    expect(runSafetyPrefilter(`${padding} chest pain`).hit).toBe(false);
    expect(runSafetyPrefilter(`chest pain ${padding}`).hit).toBe(true);
  });

  it('returns the correct non-match for repeated adversarial near-matches', () => {
    const adversarial = `${'chest chest chest pai'.repeat(95)}x`;
    expect(runSafetyPrefilter(adversarial)).toMatchObject({ hit: false });
  });
});

describe('auto-reply templates (SAFETY-04 — detect-and-redirect, never triage)', () => {
  it('the emergency template carries BOTH directives: 911 and 988', () => {
    expect(SAFETY_AUTO_REPLY_EMERGENCY).toContain('911');
    expect(SAFETY_AUTO_REPLY_EMERGENCY).toContain('988');
  });

  it.each([
    ['en', 'thank you'],
    ['fr-CA', 'merci'],
    ['es', 'gracias'],
    ['ar', 'شكرًا'],
  ] as const)('returns the fixed emergency response in %s', (language, marker) => {
    const reply = safetyAutoReplyEmergency(language);

    expect(reply.toLocaleLowerCase()).toContain(marker);
    expect(reply).toContain('911');
    expect(reply).toContain('988');
    expect(reply).not.toMatch(/(?:note\s+has\s+been\s+made|notifi|alert|avis|إبلاغ)/iu);
    expect(reply).not.toMatch(
      /(?:doctor|médecin|médico|طبيب|research\s+team|équipe|equipo|فريق)/iu,
    );
    expect(Array.from(reply).length).toBeLessThanOrEqual(320);
  });

  it('the medical-question template carries the 811 directive', () => {
    expect(SAFETY_AUTO_REPLY_MEDICAL_QUESTION).toContain('811');
  });

  it('templates are severity-language-free: no triage adjectives (banned list is the CI grep-guard source)', () => {
    expect(BANNED_SEVERITY_TERMS.length).toBeGreaterThanOrEqual(4);
    for (const required of ['severe', 'serious', 'critical', 'urgent']) {
      expect(BANNED_SEVERITY_TERMS).toContain(required);
    }
    for (const template of [SAFETY_AUTO_REPLY_EMERGENCY, SAFETY_AUTO_REPLY_MEDICAL_QUESTION]) {
      const lower = template.toLowerCase();
      for (const banned of BANNED_SEVERITY_TERMS) {
        expect(lower.includes(banned), `template must not contain '${banned}'`).toBe(false);
      }
    }
  });

  it('templates fit a single SMS segment budget (<= 320 chars, 2 concatenated GSM segments)', () => {
    expect(SAFETY_AUTO_REPLY_EMERGENCY.length).toBeLessThanOrEqual(320);
    expect(SAFETY_AUTO_REPLY_MEDICAL_QUESTION.length).toBeLessThanOrEqual(320);
  });

  // Phase-4 04-02 — the HELP keyword auto-reply (SC7 / OPS-01). Lives with the other
  // templates so the severity ban + the CI grep-guard cover it identically.
  it('the HELP template names the opt-out (STOP) and the 811 nurse line, and gives no medical advice', () => {
    expect(HELP_AUTO_REPLY).toContain('STOP');
    expect(HELP_AUTO_REPLY).toContain('811');
  });

  it('the HELP template is severity-language-free and fits the 2-segment budget', () => {
    const lower = HELP_AUTO_REPLY.toLowerCase();
    for (const banned of BANNED_SEVERITY_TERMS) {
      expect(lower.includes(banned), `HELP template must not contain '${banned}'`).toBe(false);
    }
    expect(HELP_AUTO_REPLY.length).toBeLessThanOrEqual(320);
  });

  // Phase-8 08-05 — the two fixed intake-boundary replies (audit M-13 media, M-04 limits).
  // Neither ever reaches the model, so both must stay advice-free like the templates above.
  it('the media template states the text-only boundary and never invites a media resend', () => {
    expect(MEDIA_UNSUPPORTED_REPLY.toLowerCase()).toContain('text');
    expect(MEDIA_UNSUPPORTED_REPLY).not.toMatch(/send (a |an )?(photo|picture|image|file)/i);
  });

  it('the intake-limit notice confirms receipt so the patient does not resend', () => {
    expect(INTAKE_LIMIT_NOTICE.toLowerCase()).toContain('received');
  });

  it('both intake-boundary templates are severity-language-free and fit the 2-segment budget', () => {
    for (const template of [MEDIA_UNSUPPORTED_REPLY, INTAKE_LIMIT_NOTICE]) {
      const lower = template.toLowerCase();
      for (const banned of BANNED_SEVERITY_TERMS) {
        expect(lower.includes(banned), `template must not contain '${banned}'`).toBe(false);
      }
      expect(template.length).toBeLessThanOrEqual(320);
    }
  });
});
