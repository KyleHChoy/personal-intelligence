// One project, one colour, in every room (the design's palette): the week's three projects with the
// most minutes take --p1, --p2 and --p3 in that order; every other project, and time no project was
// credited, is "Other", in the quiet --p4. Work's week bars and By project, and Today's day line,
// all colour by it.

export const OTHER = "var(--p4)";
export type Palette = { colourOf: (project: string | null) => string; top: readonly string[] };

export function projectPalette(week: readonly { project: string; minutes: number }[]): Palette {
  const top = [...week]
    .sort((a, b) => b.minutes - a.minutes || (a.project < b.project ? -1 : 1))
    .slice(0, 3)
    .map((one) => one.project);
  return {
    top,
    colourOf: (project) => {
      const place = project === null ? -1 : top.indexOf(project);
      return place === -1 ? OTHER : `var(--p${place + 1})`;
    },
  };
}
