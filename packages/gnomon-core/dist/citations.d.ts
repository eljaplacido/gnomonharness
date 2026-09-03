export interface CitationCheck {
    /** `path.ts:435`, as written in the answer. */
    raw: string;
    path: string;
    line: number;
    verdict: "ok" | "broken" | "ambiguous";
    /** Why it is broken, or the cited line's text when it is ok. */
    detail: string;
}
export interface CitationReport {
    checked: number;
    ok: number;
    broken: CitationCheck[];
    ambiguous: number;
}
/**
 * Verify every citation in `answer` against `root`.
 *
 * Best-effort by construction: anything that throws is simply not reported,
 * because a turn must not fail over its own bookkeeping.
 */
export declare function checkCitations(answer: string, root: string): CitationReport;
//# sourceMappingURL=citations.d.ts.map