// Shared profile helpers: result perspective, date formatting, rating trends,
// and identity monograms. Kept framework-free so every profile widget composes
// on the same primitives.
import type { Profile, ProfileGame, RatingCategory } from '../../api/client'
import { type Category } from '../../lib/timeControl'

export type Outcome = 'win' | 'loss' | 'draw'

// Server-side game-history filter axes (see ProfileGamesController). 'all' means
// no filter on that axis. Chess960, Duck and Antichess are each their own stored
// category — no time-control split.
export type CatFilter =
    | 'all'
    | 'bullet'
    | 'blitz'
    | 'rapid'
    | 'classical'
    | 'chess960'
    | 'duck'
    | 'antichess'
export type ResultFilter = 'all' | 'win' | 'loss' | 'draw'

export const OUTCOME_STYLE: Record<Outcome, { label: string; color: string }> = {
    win: { label: 'W', color: '#5b9e5b' },
    loss: { label: 'L', color: '#ca4a4a' },
    draw: { label: 'D', color: 'var(--text-dim)' },
}

// The four time-control categories, paired with the display label the rest of
// the app uses (so we can pull icon + accent colour from CATEGORY_META).
export const TC_CATEGORIES: { key: RatingCategory; label: Category }[] = [
    { key: 'bullet', label: 'Bullet' },
    { key: 'blitz', label: 'Blitz' },
    { key: 'rapid', label: 'Rapid' },
    { key: 'classical', label: 'Classical' },
]

export interface Perspective {
    outcome: Outcome
    color: 'White' | 'Black'
    opponent: string
    opponentBot: boolean
    delta: number | null
    ratingAfter: number | null
}

// The game result from the profiled player's own perspective + their rating
// swing (only meaningful on rated games, where before/after are populated).
export function perspective(g: ProfileGame, userId: string): Perspective {
    const isWhite = g.white_user_id === userId
    const color = isWhite ? 'White' : 'Black'
    const opponent = isWhite ? g.black_name : g.white_name
    const opponentBot = isWhite ? g.black_is_bot : g.white_is_bot

    let outcome: Outcome = 'draw'
    if (g.result === '1-0') outcome = isWhite ? 'win' : 'loss'
    else if (g.result === '0-1') outcome = isWhite ? 'loss' : 'win'

    const before = isWhite ? g.white_rating_before : g.black_rating_before
    const after = isWhite ? g.white_rating_after : g.black_rating_after
    const delta = before != null && after != null ? after - before : null

    return { outcome, color, opponent, opponentBot, delta, ratingAfter: after }
}

export function fmtDate(iso: string): string {
    const d = new Date(iso)
    if (Number.isNaN(d.getTime())) return ''
    return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })
}

// A coarse "last active" label for the identity hero, derived from the most
// recent game's date. Falls back to the absolute date beyond a month.
export function fmtRelative(iso: string): string {
    const d = new Date(iso)
    if (Number.isNaN(d.getTime())) return ''
    const day = 86_400_000
    const diff = Date.now() - d.getTime()
    if (diff < 0) return 'just now'
    if (diff < day) return 'today'
    if (diff < 2 * day) return 'yesterday'
    if (diff < 7 * day) return `${Math.floor(diff / day)} days ago`
    if (diff < 30 * day) return `${Math.floor(diff / (7 * day))}w ago`
    return fmtDate(iso)
}

/** Net rating change across a history window (oldest -> newest), or null when
 * there aren't two points to compare. Shared so the ratings panel's per-row
 * trend and anything else reading a trend can't drift on the definition. */
export function seriesDelta(series: number[]): number | null {
    return series.length >= 2 ? series[series.length - 1] - series[0] : null
}

/** The player's most-played time control. Its only job now is telling
 * `RatingsPanel` which row to highlight — this used to return a whole rating
 * bundle (number, colour, series, delta) for a hero call-out that duplicated
 * that very row, so everything but the key went with it. Null only if the
 * profile has no time-control ratings at all. */
export function primaryCategory(profile: Profile): RatingCategory | null {
    let best: RatingCategory | null = null
    let bestGames = -1
    for (const c of TC_CATEGORIES) {
        const g = profile.ratings[c.key].games
        if (g > bestGames) {
            bestGames = g
            best = c.key
        }
    }
    return best
}

const MONO_COLORS = ['#5e84c0', '#6f9e54', '#d8a657', '#e0844a', '#b06fb0', '#4aa7a0']

// Deterministic accent colour for a name's monogram avatar (stable per player).
export function monogramColor(name: string): string {
    let h = 0
    for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0
    return MONO_COLORS[h % MONO_COLORS.length]
}

export function initials(name: string): string {
    const parts = name.trim().split(/\s+/).filter(Boolean)
    if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase()
    return name.slice(0, 2).toUpperCase()
}

// ISO-3166-1 alpha-2 -> English name, for the identity hero's country line and
// the edit dialog's country select. Deliberately text-only — no flag emoji or
// images. Keep this in sync with the whitelist in App\Models\User::COUNTRIES.
export const COUNTRY_NAMES: Record<string, string> = {
    AD: 'Andorra', AE: 'United Arab Emirates', AF: 'Afghanistan', AG: 'Antigua & Barbuda',
    AI: 'Anguilla', AL: 'Albania', AM: 'Armenia', AO: 'Angola', AQ: 'Antarctica',
    AR: 'Argentina', AS: 'American Samoa', AT: 'Austria', AU: 'Australia', AW: 'Aruba',
    AX: 'Åland Islands', AZ: 'Azerbaijan',
    BA: 'Bosnia & Herzegovina', BB: 'Barbados', BD: 'Bangladesh', BE: 'Belgium',
    BF: 'Burkina Faso', BG: 'Bulgaria', BH: 'Bahrain', BI: 'Burundi', BJ: 'Benin',
    BL: 'St. Barthélemy', BM: 'Bermuda', BN: 'Brunei', BO: 'Bolivia',
    BQ: 'Caribbean Netherlands', BR: 'Brazil', BS: 'Bahamas', BT: 'Bhutan',
    BV: 'Bouvet Island', BW: 'Botswana', BY: 'Belarus', BZ: 'Belize',
    CA: 'Canada', CC: 'Cocos (Keeling) Islands', CD: 'Congo - Kinshasa',
    CF: 'Central African Republic', CG: 'Congo - Brazzaville', CH: 'Switzerland',
    CI: 'Côte d’Ivoire', CK: 'Cook Islands', CL: 'Chile', CM: 'Cameroon', CN: 'China',
    CO: 'Colombia', CR: 'Costa Rica', CU: 'Cuba', CV: 'Cape Verde', CW: 'Curaçao',
    CX: 'Christmas Island', CY: 'Cyprus', CZ: 'Czechia',
    DE: 'Germany', DJ: 'Djibouti', DK: 'Denmark', DM: 'Dominica',
    DO: 'Dominican Republic', DZ: 'Algeria',
    EC: 'Ecuador', EE: 'Estonia', EG: 'Egypt', EH: 'Western Sahara', ER: 'Eritrea',
    ES: 'Spain', ET: 'Ethiopia',
    FI: 'Finland', FJ: 'Fiji', FK: 'Falkland Islands', FM: 'Micronesia',
    FO: 'Faroe Islands', FR: 'France',
    GA: 'Gabon', GB: 'United Kingdom', GD: 'Grenada', GE: 'Georgia', GF: 'French Guiana',
    GG: 'Guernsey', GH: 'Ghana', GI: 'Gibraltar', GL: 'Greenland', GM: 'Gambia',
    GN: 'Guinea', GP: 'Guadeloupe', GQ: 'Equatorial Guinea', GR: 'Greece',
    GS: 'South Georgia & South Sandwich Islands', GT: 'Guatemala', GU: 'Guam',
    GW: 'Guinea-Bissau', GY: 'Guyana',
    HK: 'Hong Kong SAR China', HM: 'Heard & McDonald Islands', HN: 'Honduras',
    HR: 'Croatia', HT: 'Haiti', HU: 'Hungary',
    ID: 'Indonesia', IE: 'Ireland', IL: 'Israel', IM: 'Isle of Man', IN: 'India',
    IO: 'British Indian Ocean Territory', IQ: 'Iraq', IR: 'Iran', IS: 'Iceland', IT: 'Italy',
    JE: 'Jersey', JM: 'Jamaica', JO: 'Jordan', JP: 'Japan',
    KE: 'Kenya', KG: 'Kyrgyzstan', KH: 'Cambodia', KI: 'Kiribati', KM: 'Comoros',
    KN: 'St. Kitts & Nevis', KP: 'North Korea', KR: 'South Korea', KW: 'Kuwait',
    KY: 'Cayman Islands', KZ: 'Kazakhstan',
    LA: 'Laos', LB: 'Lebanon', LC: 'St. Lucia', LI: 'Liechtenstein', LK: 'Sri Lanka',
    LR: 'Liberia', LS: 'Lesotho', LT: 'Lithuania', LU: 'Luxembourg', LV: 'Latvia', LY: 'Libya',
    MA: 'Morocco', MC: 'Monaco', MD: 'Moldova', ME: 'Montenegro', MF: 'St. Martin',
    MG: 'Madagascar', MH: 'Marshall Islands', MK: 'North Macedonia', ML: 'Mali',
    MM: 'Myanmar (Burma)', MN: 'Mongolia', MO: 'Macao SAR China',
    MP: 'Northern Mariana Islands', MQ: 'Martinique', MR: 'Mauritania', MS: 'Montserrat',
    MT: 'Malta', MU: 'Mauritius', MV: 'Maldives', MW: 'Malawi', MX: 'Mexico',
    MY: 'Malaysia', MZ: 'Mozambique',
    NA: 'Namibia', NC: 'New Caledonia', NE: 'Niger', NF: 'Norfolk Island', NG: 'Nigeria',
    NI: 'Nicaragua', NL: 'Netherlands', NO: 'Norway', NP: 'Nepal', NR: 'Nauru',
    NU: 'Niue', NZ: 'New Zealand',
    OM: 'Oman',
    PA: 'Panama', PE: 'Peru', PF: 'French Polynesia', PG: 'Papua New Guinea',
    PH: 'Philippines', PK: 'Pakistan', PL: 'Poland', PM: 'St. Pierre & Miquelon',
    PN: 'Pitcairn Islands', PR: 'Puerto Rico', PS: 'Palestinian Territories',
    PT: 'Portugal', PW: 'Palau', PY: 'Paraguay',
    QA: 'Qatar',
    RE: 'Réunion', RO: 'Romania', RS: 'Serbia', RU: 'Russia', RW: 'Rwanda',
    SA: 'Saudi Arabia', SB: 'Solomon Islands', SC: 'Seychelles', SD: 'Sudan',
    SE: 'Sweden', SG: 'Singapore', SH: 'St. Helena', SI: 'Slovenia',
    SJ: 'Svalbard & Jan Mayen', SK: 'Slovakia', SL: 'Sierra Leone', SM: 'San Marino',
    SN: 'Senegal', SO: 'Somalia', SR: 'Suriname', SS: 'South Sudan',
    ST: 'São Tomé & Príncipe', SV: 'El Salvador', SX: 'Sint Maarten', SY: 'Syria',
    SZ: 'Eswatini',
    TC: 'Turks & Caicos Islands', TD: 'Chad', TF: 'French Southern Territories',
    TG: 'Togo', TH: 'Thailand', TJ: 'Tajikistan', TK: 'Tokelau', TL: 'Timor-Leste',
    TM: 'Turkmenistan', TN: 'Tunisia', TO: 'Tonga', TR: 'Türkiye',
    TT: 'Trinidad & Tobago', TV: 'Tuvalu', TW: 'Taiwan', TZ: 'Tanzania',
    UA: 'Ukraine', UG: 'Uganda', UM: 'U.S. Outlying Islands', US: 'United States',
    UY: 'Uruguay', UZ: 'Uzbekistan',
    VA: 'Vatican City', VC: 'St. Vincent & Grenadines', VE: 'Venezuela',
    VG: 'British Virgin Islands', VI: 'U.S. Virgin Islands', VN: 'Vietnam', VU: 'Vanuatu',
    WF: 'Wallis & Futuna', WS: 'Samoa',
    YE: 'Yemen', YT: 'Mayotte',
    ZA: 'South Africa', ZM: 'Zambia', ZW: 'Zimbabwe',
}
