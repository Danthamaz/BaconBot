'use strict';

/**
 * Shared officer permission check.
 *
 * A member counts as an officer if they either:
 *   - have the Manage Server permission (covers admins/guild leaders), or
 *   - hold one of the roles listed in OFFICER_ROLE_IDS (comma-separated).
 *
 * Unlike the old per-command copies of this check, an empty
 * OFFICER_ROLE_IDS no longer means "everyone is an officer" — it means
 * only members with Manage Server qualify.
 */

const { PermissionFlagsBits } = require('discord.js');

const OFFICER_ROLE_IDS = (process.env.OFFICER_ROLE_IDS || '')
  .split(',').map(s => s.trim()).filter(Boolean);

function isOfficer(member) {
  if (!member) return false;
  if (member.permissions?.has?.(PermissionFlagsBits.ManageGuild)) return true;
  return OFFICER_ROLE_IDS.some(id => member.roles.cache.has(id));
}

module.exports = { isOfficer, OFFICER_ROLE_IDS };
