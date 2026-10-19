// @medadhere/shared — public surface.
// Build-less workspace: package.json main/types/exports resolve to this file
// directly (F12). Consumers import the canonical adherence schema by name.
export { AdherenceClassification, adherenceClassificationJsonSchema } from './adherence-schema.js';

// Phase 3 — pure dose-time + Twilio status-rank helpers (PIPE-09 / SC7). Re-exported
// by name from the package index (F12 build-less convention — note the `.js` specifier
// even though the source is `.ts`, matching NodeNext module resolution).
export {
  buildScheduleExpression,
  buildTimeoutScheduleExpression,
  computeScheduledAtUtc,
  RESPONSE_WINDOW_MINUTES,
  STATUS_RANK,
  STORED_STATUS_RANK,
  STORED_STATUS_RANK_SQL_CASE,
  SCHEDULE_GROUP_NAME,
  isForwardStatusTransition,
  isForwardStoredStatusTransition,
  generateDoseSchedule,
} from './dose-time.js';
export type {
  OutboundStatus,
  StoredOnlyOutboundStatus,
  StoredOutboundStatus,
  ScheduleExpressionInput,
  ScheduledAtInput,
  DoseSlot,
  DoseScheduleInput,
} from './dose-time.js';

// Phase 4 (04-01) — the shared safety contract: SC3 prefilter lexicon, SC7 STOP/HELP
// helpers, SAFETY-04 auto-reply templates. Consumed by the inbound Lambda AND the eval
// harness (the tagged term list drives gold-set slice tagging — SC6).
export {
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
  runSafetyPrefilter,
  safetyAutoReplyEmergency,
} from './safety-lexicon.js';
export type {
  LexiconTerm,
  PrefilterResult,
  SafetyCategory,
  SafetyLanguage,
} from './safety-lexicon.js';

// Phase 8 (08-04a) — strict id-only FIFO wake and SendMessage input builders.
export {
  buildContinuationInboundReplyWake,
  buildInitialInboundReplyWake,
  inboundReplyWakeSchema,
  parseInboundReplyWake,
  serializeInboundReplyWake,
} from './inbound-event.js';
export type {
  ContinuationInboundReplyWakeInput,
  InboundReplyWake,
  InboundReplyWakeSendMessageInput,
  InitialInboundReplyWakeInput,
} from './inbound-event.js';

// Phase 4 (04-06) — DRUG-02: the shared drug_profile_json read contract + frozen-rxcui
// extractor. Consumed by the classifier handler (ADE matcher) so the matcher and DRUG-01
// agree on the stored shape (H6).
export { rxcuiFromDrugProfile } from './drug-profile.js';
export type { DrugProfile, ResolvedDrugProfile, UnresolvedDrugProfile } from './drug-profile.js';
// 04-07 D2 — the WRITER-SIDE drug_profile_json contract (review item J). The freeze script conforms to
// this so writer/reader can't drift on the ingredient-rxcui + provenance fields; the read contract
// (rxcuiFromDrugProfile) is unchanged.
export {
  drugProfileWriteSchema,
  drugProfileSchema,
  drugProfileSourceSchema,
  resolvedDrugProfileSchema,
  resolvedDrugProfileWriteSchema,
  unresolvedDrugProfileWriteSchema,
  DRUG_PROFILE_SOURCE,
} from './drug-profile.js';
export type {
  DrugProfileData,
  DrugProfileSource,
  DrugProfileWrite,
  ResolvedDrugProfileWrite,
  UnresolvedDrugProfileWrite,
} from './drug-profile.js';
export { ADE_SYNONYM_MAP, synonymHits } from './ade-synonyms.js';
export type { AdeSynonymEntry, SynonymHit } from './ade-synonyms.js';

// Phase 6 (06-03a) — shared UI/label constants consumed by W3's 06-04 (drug-label panel)
// and 06-05 (review queues), so both readers consume one source and neither re-authors it.
// U-27: the openFDA disclaimer rendered VERBATIM on any label-context surface.
export {
  FDA_DISCLAIMER_RETRIEVED_DATE,
  FDA_DISCLAIMER_SOURCE,
  FDA_LABEL_DISCLAIMER,
} from './fda-disclaimer.js';
// The associative (never causal) label-match hint builder — MedFlow discipline.
export { adeHintInputSchema, buildAdeHint } from './ade-hint.js';
export type { AdeHintLevel, AdeHintInput } from './ade-hint.js';

// Phase 8 (08-01) — strict shared conversation, evidence, summary, and review contracts.
export {
  activeMedicationContextSchema,
  clinicalFactReferenceSchema,
  clinicianReviewActionSchema,
  clinicianReviewDraftSchema,
  CONVERSATION_CLARIFICATION_TOPICS,
  CONVERSATION_SCHEMA_VERSION,
  conversationActionSchema,
  conversationClarificationTopicSchema,
  conversationMessageSchema,
  conversationObservationSchema,
  conversationTurnInputSchema,
  conversationTurnResultSchema,
  conversationTurnResultJsonSchema,
  dailySummarySchema,
  evidenceReferenceSchema,
  localeMetadataSchema,
  temporalCandidateSchema,
} from './conversation-contract.js';
export type {
  ActiveMedicationContext,
  ClinicalFactReference,
  ClinicianReviewAction,
  ClinicianReviewDraft,
  ConversationAction,
  ConversationClarificationTopic,
  ConversationMessage,
  ConversationObservation,
  ConversationTurnInput,
  ConversationTurnResult,
  DailySummary,
  EvidenceReference,
  LocaleMetadata,
  TemporalCandidate,
} from './conversation-contract.js';

// Phase 8 (08-01) — fail-closed third-party release, rights, and provenance contract.
export { sourceReleaseManifestSchema } from './source-release.js';
export type { SourceReleaseManifest } from './source-release.js';

// Phase 8 (08-03) — doctor-authored medication/fact revisions and deterministic
// interaction coverage. No result type contains a generic "safe" claim.
export {
  clinicalFactRevisionInputSchema,
  conversationDrugInteractionSchema,
  interactionCoverageResultSchema,
  medicationRevisionInputSchema,
} from './clinical-knowledge.js';
export type {
  ClinicalFactRevisionInput,
  ConversationDrugInteraction,
  InteractionCoverageResult,
  MedicationRevisionInput,
} from './clinical-knowledge.js';

// Phase 8 (08-06) — strict doctor-only review and messaging-control write contracts.
export {
  patientDetailsInputSchema,
  patientDetailsResponseSchema,
  patientReactivationInputSchema,
  patientReactivationResponseSchema,
  reminderLimitInputSchema,
  reminderLimitResponseSchema,
  reviewDecisionInputSchema,
  reviewDecisionResponseSchema,
} from './clinical-review.js';
export type {
  PatientDetailsInput,
  PatientDetailsResponse,
  PatientReactivationInput,
  PatientReactivationResponse,
  ReminderLimitInput,
  ReminderLimitResponse,
  ReviewDecisionInput,
  ReviewDecisionResponse,
} from './clinical-review.js';

export {
  medlinePlusPassageBudget,
  renderClinicalClaim,
  renderedClinicalClaimSchema,
} from './clinical-claim.js';
export type { RenderedClinicalClaim } from './clinical-claim.js';
export { containsProhibitedMedicationAdvice } from './medication-advice.js';

// Phase 8 (08-05) — pure patient-local scheduled-dose candidate generation.
export {
  extractExplicitRecentLocalDates,
  generateScheduledDoseCandidates,
  MAX_TEMPORAL_CANDIDATES,
  resolveTemporalExpression,
  scheduledDoseCandidateInputSchema,
} from './temporal-resolver.js';
export type {
  ScheduledDoseCandidateInput,
  TemporalCandidateGenerationInput,
  TemporalExpressionResolution,
  TemporalWindow,
} from './temporal-resolver.js';
