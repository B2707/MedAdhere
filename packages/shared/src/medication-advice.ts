const CHANGE_VERBS = new Set([
  'stop',
  'start',
  'restart',
  'skip',
  'change',
  'increase',
  'decrease',
  'reduce',
  'double',
  'halve',
  'arrêtez',
  'arretez',
  'commencez',
  'recommencez',
  'sautez',
  'changez',
  'augmentez',
  'diminuez',
  'réduisez',
  'reduisez',
  'doublez',
  'deje',
  'pare',
  'empiece',
  'comience',
  'reinicie',
  'salte',
  'cambie',
  'aumente',
  'disminuya',
  'reduzca',
  'duplique',
  'أوقف',
  'توقف',
  'ابدأ',
  'أعد',
  'تخط',
  'غير',
  'غيّر',
  'زد',
  'خفض',
  'خفّض',
  'قلل',
  'ضاعف',
]);

const MEDICATION_NOUNS = new Set([
  'medication',
  'medications',
  'medicine',
  'medicines',
  'meds',
  'dose',
  'dosage',
  'pill',
  'pills',
  'tablet',
  'tablets',
  'insulin',
  'prescription',
  'médicament',
  'médicaments',
  'medicament',
  'medicaments',
  'comprimé',
  'comprimés',
  'comprime',
  'comprimes',
  'pilule',
  'pilules',
  'ordonnance',
  'medicamento',
  'medicamentos',
  'medicina',
  'medicinas',
  'dosis',
  'pastilla',
  'pastillas',
  'tableta',
  'tabletas',
  'receta',
  'دواء',
  'الدواء',
  'الأدوية',
  'ادوية',
  'جرعة',
  'الجرعة',
  'حبة',
  'قرص',
  'الإنسولين',
  'الانسولين',
]);

const NEGATIONS = new Set(['not', 'never', "don't", 'dont', 'ne', 'n', 'no', 'لا']);
const REFUSAL_NEGATIONS = new Set([
  ...NEGATIONS,
  "can't",
  'cannot',
  "won't",
  'wont',
  "shouldn't",
  'shouldnt',
]);
const REFUSAL_SPEECH_VERBS = new Set(['advise', 'instruct', 'recommend', 'tell']);

function tokens(text: string): string[] {
  return text
    .normalize('NFKC')
    .toLocaleLowerCase('en-US')
    .replace(/[^\p{L}\p{M}\p{N}']+/gu, ' ')
    .trim()
    .split(/\s+/u)
    .filter(Boolean);
}

function isNegated(values: readonly string[], index: number): boolean {
  const previous = values[index - 1];
  if (previous !== undefined && NEGATIONS.has(previous)) return true;
  if (values[index - 2] === 'do' && previous === 'not') return true;
  const refusal = values.slice(Math.max(0, index - 6), index);
  return (
    previous === 'to' &&
    refusal.some((token) => REFUSAL_NEGATIONS.has(token)) &&
    refusal.some((token) => REFUSAL_SPEECH_VERBS.has(token))
  );
}

/** Narrow deterministic block for direct patient-facing medication-change instructions. */
export function containsProhibitedMedicationAdvice(text: string): boolean {
  const values = tokens(text);
  for (const [index, token] of values.entries()) {
    if (!CHANGE_VERBS.has(token) || isNegated(values, index)) continue;
    if (values.slice(index + 1, index + 6).some((value) => MEDICATION_NOUNS.has(value))) {
      return true;
    }
  }
  return false;
}
