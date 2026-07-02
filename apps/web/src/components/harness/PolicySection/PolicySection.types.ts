// PolicySection takes no props: both commands it drives
// (`get_harness_policy_file` / `update_harness_policy_file`) are scoped to the
// ACTIVE project server-side, and the section only renders inside a
// project-scoped HarnessView. This module exists to satisfy the
// folder-per-component sibling contract and is the home for any future props.
export {};
