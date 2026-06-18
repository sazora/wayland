/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import {
  approveProjectOutbound,
  clearProjectOutbound,
  createProjectContact,
  createProjectOutbound,
  formatProjectOutboundBody,
  readProjectExecutiveAssistant,
  SMS_OUTBOUND_ONLY_NOTICE,
  sendProjectOutbound,
} from '@process/services/projectExecutiveAssistant/ProjectExecutiveAssistantService';

let ws: string;

beforeEach(async () => {
  ws = await fs.mkdtemp(path.join(os.tmpdir(), 'wl-project-ea-'));
});

afterEach(async () => {
  await fs.rm(ws, { recursive: true, force: true });
});

describe('ProjectExecutiveAssistantService', () => {
  it('stores project contacts and outbound drafts in the project workspace', async () => {
    const contact = await createProjectContact(ws, {
      name: 'Norman Wood',
      company: 'PennDOT',
      role: 'Project contact',
      email: 'norman@example.com',
      preferredChannel: 'email',
      approved: true,
    });

    const outbound = await createProjectOutbound(ws, {
      contactId: contact.id,
      channel: 'email',
      to: 'norman@example.com',
      subject: 'Drone policy references',
      body: 'We imported the reference files.',
    });

    const state = await readProjectExecutiveAssistant(ws);
    expect(state.contacts).toHaveLength(1);
    expect(state.outbound).toHaveLength(1);
    expect(state.outbound[0]).toEqual(
      expect.objectContaining({
        id: outbound.id,
        contactName: 'Norman Wood',
        status: 'pending-approval',
      }),
    );
  });

  it('requires approval before sending and records missing provider failures', async () => {
    const outbound = await createProjectOutbound(ws, {
      channel: 'email',
      to: 'norman@example.com',
      subject: 'Drone policy references',
      body: 'We imported the reference files.',
    });

    await expect(sendProjectOutbound(ws, outbound.id)).rejects.toThrow('needs approval');

    await approveProjectOutbound(ws, outbound.id);
    const failed = await sendProjectOutbound(ws, outbound.id);
    expect(failed.status).toBe('failed');
    expect(failed.error).toContain('No running email sender');
  });

  it('auto-dispatches email and RCS drafts when approval is not required', async () => {
    const email = await createProjectOutbound(ws, {
      channel: 'email',
      to: 'norman@example.com',
      subject: 'Drone policy references',
      body: 'We imported the reference files.',
      requiresApproval: false,
    });

    expect(email.status).toBe('failed');
    expect(email.requiresApproval).toBe(false);
    expect(email.error).toContain('No running email sender');

    const rcs = await createProjectOutbound(ws, {
      channel: 'rcs',
      to: '+14125550123',
      body: 'Text through Twilio.',
      requiresApproval: false,
    });

    expect(rcs.channel).toBe('sms');
    expect(rcs.status).toBe('failed');
    expect(rcs.requiresApproval).toBe(false);
    expect(rcs.error).toContain('No running Twilio sender');

    const state = await readProjectExecutiveAssistant(ws);
    expect(state.outbound.map((message) => message.status)).toEqual(['failed', 'failed']);
  });

  it('adds the no-inbound-replies notice to Project Assistant SMS bodies', () => {
    expect(formatProjectOutboundBody('sms', 'Checking in on the file.')).toBe(
      `Checking in on the file.\n\n${SMS_OUTBOUND_ONLY_NOTICE}`,
    );
  });

  it('does not duplicate the no-inbound-replies notice or add it to other channels', () => {
    const smsBody = `Checking in on the file.\n\n${SMS_OUTBOUND_ONLY_NOTICE}`;

    expect(formatProjectOutboundBody('sms', smsBody)).toBe(smsBody);
    expect(formatProjectOutboundBody('email', 'Checking in on the file.')).toBe('Checking in on the file.');
    expect(formatProjectOutboundBody('imessage', 'Checking in on the file.')).toBe('Checking in on the file.');
    expect(formatProjectOutboundBody('rcs', 'Checking in on the file.')).toBe('Checking in on the file.');
  });

  it('normalizes legacy iMessage and RCS outbound drafts to Twilio text', async () => {
    const imessageContact = await createProjectContact(ws, {
      name: 'Legacy iMessage Contact',
      phone: '+14125550123',
      preferredChannel: 'imessage',
      approved: true,
    });
    expect(imessageContact.preferredChannel).toBe('sms');

    const outbound = await createProjectOutbound(ws, {
      contactId: imessageContact.id,
      channel: 'rcs',
      to: '+14125550123',
      body: 'Text through Twilio.',
    });

    expect(outbound.channel).toBe('sms');
  });

  it('clears outbound history without removing project contacts', async () => {
    const contact = await createProjectContact(ws, {
      name: 'Seth Zora',
      email: 'seth@example.com',
      phone: '+14127087088',
      preferredChannel: 'sms',
      approved: true,
    });
    await createProjectOutbound(ws, {
      contactId: contact.id,
      channel: 'sms',
      to: '+14127087088',
      body: 'Test',
    });

    const cleared = await clearProjectOutbound(ws);

    expect(cleared.contacts).toHaveLength(1);
    expect(cleared.contacts[0]?.id).toBe(contact.id);
    expect(cleared.outbound).toEqual([]);
    await expect(sendProjectOutbound(ws, 'missing-after-clear')).rejects.toThrow('Outbound message not found');
  });
});
