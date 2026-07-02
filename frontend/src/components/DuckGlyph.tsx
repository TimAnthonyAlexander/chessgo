/**
 * Quietscheentchen — a cute rubber-duck glyph used for Duck Chess (the duck on
 * the board) and the Duck Chess lobby card. Sizes to the surrounding font-size
 * (1em square), so it drops in wherever the 🦆 emoji used to live.
 */
export function DuckGlyph({ className }: { className?: string }) {
    return (
        <svg
            className={className}
            width="1em"
            height="1em"
            viewBox="0 0 100 100"
            role="img"
            aria-hidden
            style={{ display: 'block', overflow: 'visible' }}
        >
            {/* body + tail flick */}
            <path
                d="M14 62c-2-8 3-13 9-13 2-9 11-16 24-16 16 0 27 10 27 23 0 12-13 21-30 21-14 0-27-6-30-15z"
                fill="#F6C915"
            />
            {/* belly shading */}
            <path
                d="M20 63c4 8 16 13 28 13 12 0 21-4 25-11-3 9-15 15-28 15-14 0-27-6-30-15 1-1 3-2 5-2z"
                fill="#E8A70A"
                opacity="0.55"
            />
            {/* head */}
            <circle cx="63" cy="34" r="19" fill="#FDD835" />
            {/* wing */}
            <path
                d="M38 55c9-6 21-5 29 2-7 6-19 7-29 1-1-1-1-2 0-3z"
                fill="#E8A70A"
                opacity="0.7"
            />
            {/* beak */}
            <path d="M80 31c9-1 17 1 17 4 0 3-8 6-17 5-4 0-6-2-6-4s2-5 6-5z" fill="#F57C00" />
            <path d="M81 40c6 1 12 2 14 4-3 2-9 2-14 1-3-1-4-3-3-4z" fill="#E65100" />
            {/* eye */}
            <circle cx="67" cy="30" r="3.4" fill="#2A2118" />
            <circle cx="68.4" cy="28.8" r="1.1" fill="#FFFFFF" />
        </svg>
    )
}
