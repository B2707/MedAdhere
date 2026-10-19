# Safety-event researcher review log

Copy this template to:

`scripts/safety-review-logs/<YYYY-MM-DD>--<safety_event_id>.md`

The filename key is the UTC review date plus the exact `safety_event` id shown in `/reviews/safety`.
Replace every placeholder before recording the review.

> Privacy rule: do not include inbound-message text, patient names, phone numbers, medication names, or
> other tester-identifying free text. Use non-PII issue or runbook references only.

## Record key

- `safety_event_id`: `<UUID FROM QUEUE>`
- `review_date_utc`: `<YYYY-MM-DD>`

## Queue observation

- `reviewed_at_utc`: `<YYYY-MM-DDTHH:MM:SSZ>`
- `event_created_at_utc`: `<YYYY-MM-DDTHH:MM:SSZ>`
- `flag_category`: `<acute_physical | crisis | medical_question>`
- `auto_reply_status_observed`: `<sending | sent | failed | suppressed | not recorded>`
- `queue_age_minutes_observed`: `<NON-NEGATIVE INTEGER>`
- `urgent_state_observed`: `<needs follow-up | delivered | sending | delivery failed | suppressed | status unavailable>`

## Researcher record

- `reviewer_initials`: `<INITIALS>`
- `review_outcome_summary`: `<NON-PII SUMMARY>`
- `follow_up_reference`: `<NON-PII ISSUE OR RUNBOOK REFERENCE | none>`

## Additional same-day reviews

Leave this section empty for the first review. If the same event is reviewed again on the same UTC date,
append a block without changing the original review.

### Review `<YYYY-MM-DDTHH:MM:SSZ>`

- `reviewer_initials`: `<INITIALS>`
- `auto_reply_status_observed`: `<sending | sent | failed | suppressed | not recorded>`
- `queue_age_minutes_observed`: `<NON-NEGATIVE INTEGER>`
- `urgent_state_observed`: `<needs follow-up | delivered | sending | delivery failed | suppressed | status unavailable>`
- `review_outcome_summary`: `<NON-PII SUMMARY>`
- `follow_up_reference`: `<NON-PII ISSUE OR RUNBOOK REFERENCE | none>`

## Append-only corrections

Leave this section empty when the record is first created. If a correction is later required, append a
dated block below without changing or deleting the original fields.

### Correction `<YYYY-MM-DDTHH:MM:SSZ>`

- `corrected_by`: `<INITIALS>`
- `reason`: `<NON-PII REASON>`
- `correction`: `<NON-PII CORRECTED VALUE OR NOTE>`
