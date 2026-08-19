import type { SxProps, Theme } from '@mui/material'

/** The content area's width — the viewport minus the nav rail, if there is one.
 *  `--nav-rail-w` is set on the content column in components/Layout.tsx and is
 *  `0px` whenever no rail is rendered. */
const CONTENT_W = 'calc(100vw - var(--nav-rail-w, 0px))'

/** Break a child out of its page's max-width column and span the full CONTENT
 *  area — for things that want every pixel they can get (the arena timeline).
 *
 *  The naive version of this is `width: 100vw; margin-left: calc(50% - 50vw)`,
 *  which is correct only when the column is centred in the VIEWPORT. It is not
 *  in the side-rail layout: there the column sits to the right of a 232px nav,
 *  so its centre is half a rail right of the viewport's. A 100vw break-out is
 *  then a rail too wide AND starts half a rail too far left, which is what put
 *  the timeline's sticky lane-name gutter underneath the nav.
 *
 *  Measuring against the content area instead fixes both, and with no rail it
 *  reduces exactly to the viewport version.
 *
 *  The `%` resolves against the element's own width, i.e. the column's: half the
 *  column minus half the content area walks the left edge out to where the
 *  content area starts.
 *
 *  Carries its own horizontal padding so bled-out content doesn't run into the
 *  window edge; spread and override (`{ ...fullBleedSx(), px: 0 }`) for edge-to-edge. */
export function fullBleedSx(): SxProps<Theme> {
    return {
        width: CONTENT_W,
        marginLeft: `calc(50% - ${CONTENT_W} / 2)`,
        px: { xs: 1.5, md: 3 },
    }
}
