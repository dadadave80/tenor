/**
 * Outbound links that are not chain reads.
 *
 * `REPO` is a constant because it was wrong in two places: both the footer and the contracts strip
 * pointed at `dadadave80/lattice`, the module library Tenor is built from, rather than at Tenor
 * itself. A judge following "Repository" would have landed in the wrong project.
 */
export const REPO = process.env.NEXT_PUBLIC_REPO_URL ?? 'https://github.com/dadadave80/tenor'
export const LATTICE = 'https://github.com/dadadave80/lattice'
