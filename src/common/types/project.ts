/**
 * @license
 * Copyright 2026 Ferrox Labs
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * A Project is an umbrella that owns conversations. Each conversation keeps full
 * freedom of backend / model / assistant - the project does not constrain that.
 * Scoping is carried on the conversation via `extra.projectId` (mirrors the
 * `cronJobId` pattern), so there is no per-conversation column and no execution
 * lock. The project entity itself lives in the `projects` SQLite table
 * (migration_v43).
 *
 * Deliberately leaner than Foundry's IProject: dropped `defaultAgent` /
 * `defaultModel` (the composer picks per-chat), `forgeInitialized`, and
 * `activeConversationId` (the per-project execution lock that serialized every
 * chat - the core friction we are removing).
 */
export type IProject = {
  id: string;
  name: string;
  description?: string;
  /** Optional working directory. When set, a `.wayland/` knowledge folder is bootstrapped here. */
  workspace?: string;
  /** Project-specific inbound email local part, e.g. `penndot` for `penndot@wl.cksz.us`. */
  emailAlias?: string;
  /** Whether inbound email to the alias is accepted for this project. */
  emailIntakeEnabled?: boolean;
  /** Optional lowercased sender allowlist. Empty means any sender is accepted. */
  emailAllowedSenders?: string[];
  /** What WL does after receiving an email. */
  emailIngestBehavior?:
    | 'save'
    | 'save-and-notify'
    | 'save-and-summarize'
    | 'save-add-to-knowledge'
    | 'act-on-instructions'
    | 'act-add-knowledge-and-references';
  /** Icon-park / lucide icon name for the project tile. */
  icon?: string;
  /** Hex color for the icon chip. */
  iconColor?: string;
  pinned: boolean;
  pinnedAt?: number;
  createTime: number;
  modifyTime: number;
};

/** Parameters accepted when creating a project. Everything except `name` is optional to keep activation energy low. */
export type ICreateProjectParams = {
  name: string;
  description?: string;
  workspace?: string;
  emailAlias?: string;
  emailIntakeEnabled?: boolean;
  emailAllowedSenders?: string[];
  emailIngestBehavior?: IProject['emailIngestBehavior'];
  icon?: string;
  iconColor?: string;
};

/** Fields a user may edit on an existing project. */
export type IUpdateProjectParams = Partial<
  Pick<
    IProject,
    | 'name'
    | 'description'
    | 'workspace'
    | 'emailAlias'
    | 'emailIntakeEnabled'
    | 'emailAllowedSenders'
    | 'emailIngestBehavior'
    | 'icon'
    | 'iconColor'
    | 'pinned'
    | 'pinnedAt'
  >
>;
