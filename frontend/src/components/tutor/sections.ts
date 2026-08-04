/**
 * The report's jump-nav targets, defined once.
 *
 * The rail needs to know which sections are on the page and where they are;
 * the sections themselves are rendered several components deep. Rather than
 * have the rail find them by matching heading TEXT in the DOM — which breaks
 * silently the first time someone rewords a heading — each section passes its
 * id to `SectionHead` and the rail looks the ids up. The id is the contract,
 * the wording is free to change.
 *
 * `label` is what the rail shows, and it is deliberately allowed to differ
 * from the section's own heading: the rail has ~200px and the heading does not.
 */
export interface TutorSection {
    id: string
    label: string
}

export const TUTOR_SECTIONS: TutorSection[] = [
    { id: 'tutor-section-findings', label: 'What stands out' },
    { id: 'tutor-section-metrics', label: 'Every metric' },
    { id: 'tutor-section-openings', label: 'Openings' },
    { id: 'tutor-section-themes', label: 'Tactical themes' },
]

export const SECTION_FINDINGS = TUTOR_SECTIONS[0].id
export const SECTION_METRICS = TUTOR_SECTIONS[1].id
export const SECTION_OPENINGS = TUTOR_SECTIONS[2].id
export const SECTION_THEMES = TUTOR_SECTIONS[3].id
