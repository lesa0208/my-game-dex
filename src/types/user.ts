export type Collector = {
  id: string;
  displayName: string;
  handle: string;
  avatarUrl?: string;
};

/** A collector as seen by the current viewer. */
export type SuggestedCollector = Collector & {
  gamesCataloged: number;
  focus: string;
};
