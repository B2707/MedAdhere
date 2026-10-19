# openFDA reviewed terms boundary

Reviewed from `https://open.fda.gov/terms/` and `https://open.fda.gov/apis/drug/label/` on 2026-08-11.

The terms state that, unless otherwise noted, openFDA content and data are public domain and available under CC0 1.0. They also state that non-public-domain works will be clearly marked in the relevant documentation. The drug-label API documentation reviewed for this release contains no such dataset warning.

This release contains only the six exact, bounded label passages listed in `reviewed-label-passages.json`, with label identifiers, dates, and source links. It excludes GMDN, unreviewed sections, diagnosis, treatment advice, and any record carrying a non-public-domain warning. The application preserves FDA attribution and the label identifier even though attribution is not required by CC0.

The drug-label documentation warns that submitted labeling is reformatted but not verified by FDA and may not match currently distributed or approved labeling. MedAdhere therefore treats these rows as bounded evidence for doctor review, never as a complete source or care instruction.
