/** A sample reviewer verdict requesting changes, ending with the machine-readable
 *  line the core greps for. Drives the ReviewPanel + verified-card stories/tests. */
export const SAMPLE_REVIEW_CHANGES =
  'The migration backfills the new column but never guards against a null email,\n' +
  'so existing rows with no address violate the NOT NULL constraint.\n\n' +
  'Required fixes:\n' +
  '1. Default the backfill to an empty string when email is null.\n' +
  '2. Add a test over a row with a null email.\n\n' +
  'VERDICT: CHANGES_REQUESTED';

/** A passing reviewer verdict. */
export const SAMPLE_REVIEW_PASS =
  'The auth guard covers every protected route and the tests exercise the\n' +
  'unauthenticated path. The diff is complete and correct.\n\nVERDICT: PASS';
