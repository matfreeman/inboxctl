/**
 * Test database utilities
 * Creates in-memory SQLite databases seeded with test email data
 */

import type { EmailMessage } from "../../core/gmail/types.js";

// Test sender data for consistent analytics testing
export const TEST_SENDERS = {
  github: { email: "notifications@github.com", name: "GitHub" },
  devto: { email: "newsletter@dev.to", name: "DEV Community" },
  boss: { email: "boss@company.com", name: "Boss" },
  stripe: { email: "receipts@stripe.com", name: "Stripe" },
  marketing: { email: "noreply@marketing.co", name: "MarketingCo" },
  colleague: { email: "colleague@company.com", name: "Colleague" },
} as const;

export function createTestEmail(overrides: Partial<EmailMessage> = {}): EmailMessage {
  return {
    id: `msg_${Math.random().toString(36).slice(2, 10)}`,
    threadId: `thread_${Math.random().toString(36).slice(2, 10)}`,
    fromAddress: "test@example.com",
    fromName: "Test Sender",
    toAddresses: ["user@gmail.com"],
    subject: "Test email subject",
    snippet: "This is a test email snippet...",
    date: Date.now(),
    isRead: false,
    isStarred: false,
    labelIds: ["INBOX", "UNREAD"],
    sizeEstimate: 1024,
    hasAttachments: false,
    listUnsubscribe: null,
    ...overrides,
  };
}

/**
 * Generate the standard 50-email test dataset used by analytics tests.
 */
export function generateTestEmails(): EmailMessage[] {
  const now = Date.now();
  const DAY = 86400000;
  const emails: EmailMessage[] = [];

  // GitHub: 15 emails, 5 unread
  for (let i = 0; i < 15; i++) {
    emails.push(
      createTestEmail({
        fromAddress: TEST_SENDERS.github.email,
        fromName: TEST_SENDERS.github.name,
        subject: `[repo] PR #${100 + i}: Feature update`,
        date: now - i * DAY * 0.5,
        isRead: i >= 5,
        labelIds: i >= 5 ? ["INBOX"] : ["INBOX", "UNREAD"],
      }),
    );
  }

  // dev.to: 10 emails, 9 unread (newsletter)
  for (let i = 0; i < 10; i++) {
    emails.push(
      createTestEmail({
        fromAddress: TEST_SENDERS.devto.email,
        fromName: TEST_SENDERS.devto.name,
        subject: `Weekly Digest #${50 + i}`,
        date: now - i * DAY * 3,
        isRead: i === 0,
        labelIds: i === 0 ? ["INBOX"] : ["INBOX", "UNREAD"],
        listUnsubscribe: "<https://dev.to/unsubscribe>",
      }),
    );
  }

  // Boss: 8 emails, 2 unread
  for (let i = 0; i < 8; i++) {
    emails.push(
      createTestEmail({
        fromAddress: TEST_SENDERS.boss.email,
        fromName: TEST_SENDERS.boss.name,
        subject: `Q2 Planning - Update ${i + 1}`,
        date: now - i * DAY,
        isRead: i >= 2,
        labelIds: i >= 2 ? ["INBOX"] : ["INBOX", "UNREAD"],
      }),
    );
  }

  // Stripe: 7 emails, 0 unread (receipts)
  for (let i = 0; i < 7; i++) {
    emails.push(
      createTestEmail({
        fromAddress: TEST_SENDERS.stripe.email,
        fromName: TEST_SENDERS.stripe.name,
        subject: `Payment receipt for $${(i + 1) * 29.99}`,
        date: now - i * DAY * 4,
        isRead: true,
        labelIds: ["INBOX"],
      }),
    );
  }

  // Marketing: 5 emails, 5 unread
  for (let i = 0; i < 5; i++) {
    emails.push(
      createTestEmail({
        fromAddress: TEST_SENDERS.marketing.email,
        fromName: TEST_SENDERS.marketing.name,
        subject: `${(i + 1) * 10}% off everything!`,
        date: now - i * DAY * 2,
        isRead: false,
        labelIds: ["INBOX", "UNREAD"],
        listUnsubscribe: "<https://marketing.co/unsubscribe>",
      }),
    );
  }

  // Colleague: 5 emails, 1 unread
  for (let i = 0; i < 5; i++) {
    emails.push(
      createTestEmail({
        fromAddress: TEST_SENDERS.colleague.email,
        fromName: TEST_SENDERS.colleague.name,
        subject: `Re: Sprint review notes ${i + 1}`,
        date: now - i * DAY * 1.5,
        isRead: i >= 1,
        labelIds: i >= 1 ? ["INBOX"] : ["INBOX", "UNREAD"],
      }),
    );
  }

  return emails;
}
