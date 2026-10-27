import type { FastifyInstance } from 'fastify';
import { db } from '../db.js';
import { adminCount, changePassword, createUser, destroyUserSessions, findUserRow, getUserRow } from '../auth.js';
import { forgetUserSettings } from '../settings.js';
import { allChannelNames } from '../lib/videos.js';
import { passwordProblem, usernameProblem } from './auth.js';

interface UserListRow {
  id: number;
  username: string;
  is_admin: number;
  all_channels: number;
  totp_enabled: number;
  created_at: number;
  last_active: number | null;
}

function channelsOf(userId: number): string[] {
  return (db.prepare('SELECT channel_id FROM user_channels WHERE user_id = ?').all(userId) as { channel_id: string }[]).map(
    (row) => row.channel_id,
  );
}

function setChannels(userId: number, ids: unknown): void {
  if (!Array.isArray(ids)) return;
  const known = new Set(allChannelNames().map((c) => c.id));
  const insert = db.prepare('INSERT OR IGNORE INTO user_channels (user_id, channel_id) VALUES (?, ?)');
  db.transaction(() => {
    db.prepare('DELETE FROM user_channels WHERE user_id = ?').run(userId);
    for (const raw of ids) {
      const id = String(raw);
      if (known.has(id)) insert.run(userId, id);
    }
  })();
}

function listUsers() {
  const rows = db
    .prepare(
      `SELECT id, username, is_admin, all_channels, totp_enabled, created_at, last_active
         FROM users ORDER BY username COLLATE NOCASE ASC`,
    )
    .all() as UserListRow[];
  return rows.map((row) => ({
    id: row.id,
    username: row.username,
    isAdmin: row.is_admin === 1,
    allChannels: row.all_channels === 1,
    channels: row.all_channels === 1 ? [] : channelsOf(row.id),
    twoFactor: row.totp_enabled === 1,
    createdAt: row.created_at,
    lastActive: row.last_active,
  }));
}

/**
 * Account management. Every route here is for administrators only, and the
 * server always keeps at least one administrator: the last one can be neither
 * demoted nor deleted.
 */
export function registerUserRoutes(app: FastifyInstance): void {
  const adminOnly = { config: { admin: true } };

  app.get('/api/users', adminOnly, async () => ({ items: listUsers(), channels: allChannelNames() }));

  app.post('/api/users', adminOnly, async (request, reply) => {
    const body = (request.body ?? {}) as any;
    const problem = usernameProblem(body.username) ?? passwordProblem(body.password);
    if (problem) return reply.code(400).send({ error: problem });
    const username = String(body.username).trim();
    if (findUserRow(username)) return reply.code(409).send({ error: 'That username is taken' });

    const user = createUser(username, String(body.password), body.isAdmin === true);
    if (body.allChannels === false) {
      db.prepare('UPDATE users SET all_channels = 0 WHERE id = ?').run(user.id);
      setChannels(user.id, body.channels);
    }
    request.log.info(`"${request.user!.username}" created the account "${username}"`);
    return { items: listUsers() };
  });

  app.patch('/api/users/:id', adminOnly, async (request, reply) => {
    const id = Number.parseInt(String((request.params as any).id), 10);
    const body = (request.body ?? {}) as any;
    const target = Number.isSafeInteger(id) ? getUserRow(id) : undefined;
    if (!target) return reply.code(404).send({ error: 'No such user' });

    if (body.username !== undefined) {
      const problem = usernameProblem(body.username);
      if (problem) return reply.code(400).send({ error: problem });
      const username = String(body.username).trim();
      const clash = findUserRow(username);
      if (clash && clash.id !== id) return reply.code(409).send({ error: 'That username is taken' });
    }
    if (body.password !== undefined) {
      const problem = passwordProblem(body.password);
      if (problem) return reply.code(400).send({ error: problem });
    }
    if (body.isAdmin === false && target.is_admin === 1 && adminCount() <= 1) {
      return reply.code(400).send({ error: 'There has to be at least one administrator' });
    }

    db.transaction(() => {
      if (body.username !== undefined) {
        db.prepare('UPDATE users SET username = ? WHERE id = ?').run(String(body.username).trim(), id);
      }
      if (typeof body.isAdmin === 'boolean') {
        db.prepare('UPDATE users SET is_admin = ? WHERE id = ?').run(body.isAdmin ? 1 : 0, id);
      }
      if (typeof body.allChannels === 'boolean') {
        db.prepare('UPDATE users SET all_channels = ? WHERE id = ?').run(body.allChannels ? 1 : 0, id);
      }
      if (body.channels !== undefined) setChannels(id, body.channels);
      if (body.resetTwoFactor === true) {
        db.prepare(
          'UPDATE users SET totp_enabled = 0, totp_secret = NULL, totp_recovery = NULL, totp_last_step = NULL WHERE id = ?',
        ).run(id);
      }
    })();

    // A new password signs the account out everywhere — which, when an
    // administrator resets their own, includes this device.
    if (body.password !== undefined) changePassword(id, String(body.password));
    if (body.signOut === true) destroyUserSessions(id);
    forgetUserSettings(id);
    request.log.info(`"${request.user!.username}" changed the account "${target.username}"`);
    return { items: listUsers() };
  });

  app.delete('/api/users/:id', adminOnly, async (request, reply) => {
    const id = Number.parseInt(String((request.params as any).id), 10);
    const target = Number.isSafeInteger(id) ? getUserRow(id) : undefined;
    if (!target) return reply.code(404).send({ error: 'No such user' });
    if (id === request.user!.id) {
      return reply.code(400).send({ error: 'You cannot delete your own account — ask another administrator' });
    }
    if (target.is_admin === 1 && adminCount() <= 1) {
      return reply.code(400).send({ error: 'There has to be at least one administrator' });
    }
    // Sessions, progress, queue, playlists and channel grants all cascade.
    db.prepare('DELETE FROM users WHERE id = ?').run(id);
    forgetUserSettings(id);
    request.log.info(`"${request.user!.username}" deleted the account "${target.username}"`);
    return { items: listUsers() };
  });
}
