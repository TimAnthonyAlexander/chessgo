// The app's ONE nav model, and the single reason the top bar and the desktop
// sidebar can never list different destinations: both render this. A `link` is a
// plain top-level destination; a `menu` is a group of leaves whose own label may
// ALSO be a destination (e.g. "Play" opens Online/Computer but itself goes to "/").
//
// It lives here rather than in either nav because Layout renders the sidebar and
// the sidebar needs the model — importing it back out of Layout would be a cycle.

export interface Leaf {
    label: string
    to: string
    // Router state carried on navigation — e.g. Play → Chess960/Duck Chess/Crazyhouse/
    // Antichess land on Home ("/") and start quick pairing instantly via useHome's
    // quickPair intent.
    state?: { quickPair: 'chess960' | 'duck' | 'crazyhouse' | 'antichess' }
}
export type NavItem =
    | { kind: 'link'; label: string; to: string }
    | { kind: 'menu'; label: string; to?: string; items: Leaf[] }

export function navItems(isAdmin: boolean, loggedIn: boolean, ready: boolean): NavItem[] {
    const tools: Leaf[] = [
        { label: 'Analysis', to: '/analysis' },
        ...(isAdmin ? [{ label: 'Engine v Engine', to: '/engine-vs' }] : []),
        { label: 'Editor', to: '/editor' },
        { label: 'Tutor', to: '/tutor' },
    ]
    // While auth is still resolving, show only the items whose identity does not
    // depend on the session (Play + Tournaments). The rest (Community/Watch,
    // Tools, Admin) all appear at once when ready — no per-slot layout shifts.
    const publicOnly: NavItem[] = [
        {
            kind: 'menu',
            label: 'Play',
            to: '/',
            items: [
                { label: 'Online', to: '/' },
                { label: 'Computer', to: '/bot' },
                { label: 'Puzzles', to: '/puzzles' },
                { label: 'Premove Trainer', to: '/premove' },
                { label: 'Chess960', to: '/', state: { quickPair: 'chess960' } },
                { label: 'Duck Chess', to: '/', state: { quickPair: 'duck' } },
                { label: 'Crazyhouse', to: '/', state: { quickPair: 'crazyhouse' } },
                { label: 'Antichess', to: '/', state: { quickPair: 'antichess' } },
                { label: 'Guess the Elo', to: '/guess-the-elo' },
            ],
        },
        { kind: 'link', label: 'Tournaments', to: '/tournaments' },
    ]
    if (!ready) return publicOnly

    return [
        ...publicOnly,
        loggedIn
            ? {
                  kind: 'menu' as const,
                  label: 'Community',
                  to: '/watch',
                  items: [
                      { label: 'Watch', to: '/watch' },
                      { label: 'Friends', to: '/friends' },
                  ],
              }
            : ({ kind: 'link' as const, label: 'Watch', to: '/watch' } as NavItem),
        { kind: 'menu', label: 'Tools', to: '/analysis', items: tools },
        ...(isAdmin ? [{ kind: 'link' as const, label: 'Admin', to: '/admin' }] : []),
    ]
}

/** Is `to` the page currently shown? "/" matches exactly; everything else
 *  matches by prefix, so /tutor/123 keeps the Tutor entry lit. */
export const isActive = (to: string, pathname: string): boolean =>
    to === '/' ? pathname === '/' : pathname.startsWith(to)
