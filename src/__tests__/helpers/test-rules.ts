/**
 * Test rule fixtures for rule engine testing
 */

export const VALID_RULE_YAML = `
name: test-archive-marketing
description: Archive marketing emails
enabled: true
priority: 10

conditions:
  operator: OR
  matchers:
    - field: from
      values:
        - "noreply@marketing.co"
        - "promo@store.com"
    - field: subject
      contains:
        - "% off"
        - "limited time"

actions:
  - type: mark_read
  - type: label
    label: "Marketing"
  - type: archive
`;

export const VALID_RULE_LABEL_ONLY = `
name: test-label-receipts
description: Label receipt emails
enabled: true
priority: 30

conditions:
  operator: OR
  matchers:
    - field: subject
      contains:
        - "receipt"
        - "invoice"

actions:
  - type: label
    label: "Receipts"
`;

export const INVALID_RULE_NO_NAME = `
description: Missing name field
enabled: true
conditions:
  operator: OR
  matchers:
    - field: from
      values: ["test@example.com"]
actions:
  - type: archive
`;

export const INVALID_RULE_BAD_NAME = `
name: My Rule With Spaces
description: Non-kebab-case name
enabled: true
conditions:
  operator: OR
  matchers:
    - field: from
      values: ["test@example.com"]
actions:
  - type: archive
`;

export const INVALID_RULE_DELETE_ACTION = `
name: test-delete
description: Attempts a delete action (should be rejected)
enabled: true
conditions:
  operator: OR
  matchers:
    - field: from
      values: ["test@example.com"]
actions:
  - type: delete
`;

export const INVALID_RULE_NO_MATCHERS = `
name: test-no-matchers
description: Empty matchers array
enabled: true
conditions:
  operator: OR
  matchers: []
actions:
  - type: archive
`;

export const INVALID_RULE_NO_ACTIONS = `
name: test-no-actions
description: Empty actions array
enabled: true
conditions:
  operator: OR
  matchers:
    - field: from
      values: ["test@example.com"]
actions: []
`;
